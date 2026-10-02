import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { Model, Connection } from 'mongoose';
import { NumberingService } from 'src/shared/services/numbering.service';
import { InventoryEngineService } from 'src/shared/services/inventory-engine.service';
import { AuditLogService } from 'src/shared/audit-logs/audit-logs.service';

@Injectable()
export class TransfersService {
  constructor(
    @InjectModel('Transfer') private readonly transferModel: Model<any>,
    @InjectConnection() private readonly connection: Connection,
    private readonly numberingService: NumberingService,
    private readonly inventoryEngineService: InventoryEngineService,
    private readonly auditLogService: AuditLogService,
  ) {}

  // ─── CREATE (Draft) ───────────────────────────────────────────────────────
  async create(createDto: any, userId: string) {
    if (
      createDto.fromWarehouseId &&
      createDto.toWarehouseId &&
      createDto.fromWarehouseId.toString() ===
        createDto.toWarehouseId.toString()
    ) {
      throw new BadRequestException(
        'Source and destination warehouses cannot be the same',
      );
    }

    const session = await this.connection.startSession();
    session.startTransaction();
    try {
      const transferNumber =
        await this.numberingService.generateTRNNumber(session);

      const transfer = new this.transferModel({
        ...createDto,
        transferNumber, // ← correct field name matching the schema
        status: 'Draft',
        createdBy: userId,
      });

      await transfer.save({ session });

      await this.auditLogService.log({
        userId,
        action: 'CREATE',
        entity: 'Transfer',
        entityId: transfer._id,
        details: `Created Transfer ${transferNumber}`,
      });

      await session.commitTransaction();
      return { message: 'Transfer created successfully', data: transfer };
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  // ─── FIND ALL (paginated, filtered) ──────────────────────────────────────
  async findAll(rawQuery: any = {}) {
    // Extract known pagination/filter params — do NOT pass raw object to Mongo
    const {
      page = 1,
      limit = 50,
      status,
      fromWarehouseId,
      toWarehouseId,
      warehouseId,
      search,
    } = rawQuery;

    // Always exclude soft-deleted records (filter applied here, not via pre-hook)
    const filter: Record<string, any> = { isDeleted: { $ne: true } };

    if (status) filter.status = status;

    // warehouseId matches either source or destination
    if (warehouseId) {
      filter.$or = [
        { fromWarehouseId: warehouseId },
        { toWarehouseId: warehouseId },
      ];
    } else {
      if (fromWarehouseId) filter.fromWarehouseId = fromWarehouseId;
      if (toWarehouseId) filter.toWarehouseId = toWarehouseId;
    }

    if (search) {
      const searchRegex = new RegExp(search, 'i');
      const searchCondition = [
        { transferNumber: searchRegex },
        { requestedBy: searchRegex },
        { notes: searchRegex },
      ];
      if (filter.$or) {
        // Combine warehouse $or with search $or using $and
        filter.$and = [
          { $or: filter.$or },
          { $or: searchCondition },
        ];
        delete filter.$or;
      } else {
        filter.$or = searchCondition;
      }
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    const [data, total] = await Promise.all([
      this.transferModel
        .find(filter)
        .populate('fromWarehouseId', 'code name location')
        .populate('toWarehouseId', 'code name location')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean()
        .exec(),
      this.transferModel.countDocuments(filter),
    ]);

    return {
      data,
      meta: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
    };
  }

  // ─── FIND ONE ─────────────────────────────────────────────────────────────
  async findOne(id: string) {
    const transfer = await this.transferModel
      .findOne({ _id: id, isDeleted: { $ne: true } })
      .populate('fromWarehouseId', 'code name location')
      .populate('toWarehouseId', 'code name location')
      .lean()
      .exec();
    if (!transfer) throw new NotFoundException('Transfer not found');
    return { data: transfer };
  }

  // ─── UPDATE / POST ────────────────────────────────────────────────────────
  async update(id: string, dto: any, userId: string) {
    // If the caller is setting status to "Posted", run the posting workflow
    if (dto.status === 'Posted') {
      return this.postTransfer(id, userId);
    }

    // Otherwise, only allow editing Draft/Pending Approval transfers
    const transfer = await this.transferModel.findById(id).exec();
    if (!transfer) throw new NotFoundException('Transfer not found');
    if (transfer.status === 'Posted') {
      throw new BadRequestException('Cannot edit a Posted transfer');
    }
    if (transfer.status === 'Cancelled') {
      throw new BadRequestException('Cannot edit a Cancelled transfer');
    }

    Object.assign(transfer, dto);
    await transfer.save();
    return { message: 'Transfer updated successfully', data: transfer };
  }

  // ─── POST (execute stock movement) ───────────────────────────────────────
  private async postTransfer(id: string, userId: string) {
    const session = await this.connection.startSession();
    session.startTransaction();
    try {
      const transfer = await this.transferModel.findById(id).session(session);
      if (!transfer) throw new NotFoundException('Transfer not found');

      if (transfer.status === 'Posted') {
        throw new BadRequestException('Transfer is already Posted');
      }
      if (transfer.status === 'Cancelled') {
        throw new BadRequestException('Cannot post a Cancelled transfer');
      }
      if (!transfer.items || transfer.items.length === 0) {
        throw new BadRequestException('Transfer has no items');
      }

      const transferNumber =
        transfer.transferNumber || transfer.trnNumber || id;

      // ── Step 1: Validate all items have sufficient stock ─────────────────
      for (const item of transfer.items) {
        const inventoryItem =
          await this.inventoryEngineService.checkAvailability(item.itemCode);
        if ((inventoryItem.quantity || 0) < item.quantity) {
          throw new BadRequestException(
            `Insufficient stock for item "${item.itemName || item.itemCode}". ` +
              `Available: ${inventoryItem.quantity || 0}, Requested: ${item.quantity}`,
          );
        }
      }

      // ── Step 2: Deduct from source & add to destination ──────────────────
      for (const item of transfer.items) {
        // Deduct global stock (TRN_OUT movement)
        await this.inventoryEngineService.deductStock(
          item.itemCode,
          item.quantity,
          `${transferNumber}/OUT`,
          'TRN',
          session,
        );

        // Add global stock (TRN_IN movement)
        await this.inventoryEngineService.addStock(
          item.itemCode,
          item.quantity,
          `${transferNumber}/IN`,
          'TRN',
          session,
        );
      }

      // ── Step 3: Mark transfer as Posted ──────────────────────────────────
      transfer.status = 'Posted';
      transfer.postedBy = userId;
      transfer.postedAt = new Date();
      await transfer.save({ session });

      await this.auditLogService.log({
        userId,
        action: 'POST',
        entity: 'Transfer',
        entityId: transfer._id,
        details: `Posted Transfer ${transferNumber} — ${transfer.items.length} item(s)`,
      });

      await session.commitTransaction();
      return {
        message: 'Transfer posted successfully. Stock balances updated.',
        data: transfer,
      };
    } catch (error) {
      await session.abortTransaction();
      // Always re-throw the original error — never swallow the real cause
      throw error;
    } finally {
      session.endSession();
    }
  }

  // ─── CANCEL ───────────────────────────────────────────────────────────────
  async cancel(id: string, userId: string) {
    const transfer = await this.transferModel.findById(id).exec();
    if (!transfer) throw new NotFoundException('Transfer not found');
    if (transfer.status === 'Posted') {
      throw new BadRequestException('Cannot cancel a Posted transfer');
    }
    if (transfer.status === 'Cancelled') {
      throw new BadRequestException('Transfer is already Cancelled');
    }
    transfer.status = 'Cancelled';
    transfer.cancelledBy = userId;
    transfer.cancelledAt = new Date();
    await transfer.save();
    return { message: 'Transfer cancelled successfully', data: transfer };
  }

  // ─── REMOVE (soft delete) ─────────────────────────────────────────────────
  async remove(id: string, userId: string) {
    const transfer = await this.transferModel.findById(id).exec();
    if (!transfer) throw new NotFoundException('Transfer not found');
    if (transfer.status === 'Posted') {
      throw new BadRequestException('Cannot delete a Posted transfer');
    }
    transfer.isDeleted = true;
    transfer.deletedBy = userId;
    transfer.deletedAt = new Date();
    await transfer.save();
    return { message: 'Transfer deleted successfully' };
  }
}
