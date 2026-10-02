import { MongooseModule, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

@Schema({ _id: true })
export class TransferItem {
  @Prop({ type: String, required: true }) itemCode!: string;
  @Prop({ type: String, required: true }) itemName!: string;
  @Prop({ type: Number, required: true }) quantity!: number;
  @Prop({ type: String, required: true }) uom!: string;
  @Prop({ type: Number, default: 0 }) unitPrice!: number;
}
const TransferItemSchema = SchemaFactory.createForClass(TransferItem);

@Schema({ timestamps: true })
export class Transfer {
  @Prop({ type: String, unique: true, sparse: true, index: true })
  transferNumber!: string; // TRN-2026-0001

  /** Legacy alias kept for backwards compatibility with older documents */
  @Prop({ type: String, sparse: true }) trnNumber?: string;

  @Prop({ type: Types.ObjectId, ref: 'Warehouse', required: true })
  fromWarehouseId!: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'Warehouse', required: true })
  toWarehouseId!: Types.ObjectId;

  @Prop({ type: Date, default: Date.now }) transferDate!: Date;
  @Prop({ type: String }) requestedBy?: string;
  @Prop({ type: Types.ObjectId }) createdBy?: Types.ObjectId;

  @Prop({
    type: String,
    enum: ['Draft', 'Pending Approval', 'Approved', 'Posted', 'Cancelled'],
    default: 'Draft',
  })
  status!: string;

  @Prop({ type: String }) reason?: string;
  @Prop({ type: String }) notes?: string;

  @Prop({ type: [TransferItemSchema], default: [] }) items!: TransferItem[];

  // Approval fields
  @Prop({ type: Types.ObjectId }) approvedBy?: Types.ObjectId;
  @Prop({ type: Date }) approvedAt?: Date;

  // Posting fields
  @Prop({ type: Types.ObjectId }) postedBy?: Types.ObjectId;
  @Prop({ type: Date }) postedAt?: Date;

  // Cancellation fields
  @Prop({ type: Types.ObjectId }) cancelledBy?: Types.ObjectId;
  @Prop({ type: Date }) cancelledAt?: Date;

  // Soft-delete fields
  @Prop({ type: Boolean, default: false }) isDeleted!: boolean;
  @Prop({ type: Types.ObjectId }) deletedBy?: Types.ObjectId;
  @Prop({ type: Date }) deletedAt?: Date;
}

export const TransferSchema = SchemaFactory.createForClass(Transfer);

// Exclude soft-deleted documents from all find queries
function excludeDeleted(this: any, next: () => void) {
  if (!this.getQuery()['isDeleted']) {
    this.where({ isDeleted: { $ne: true } });
  }
  next();
}
TransferSchema.pre('find', excludeDeleted);
TransferSchema.pre('findOne', excludeDeleted);
TransferSchema.pre('findOneAndUpdate', excludeDeleted);
TransferSchema.pre('countDocuments', excludeDeleted);

// Compound index for common list queries
TransferSchema.index({ status: 1, createdAt: -1 });
TransferSchema.index({ fromWarehouseId: 1, status: 1 });
TransferSchema.index({ toWarehouseId: 1, status: 1 });

export const TransferModelName = Transfer.name;
export const TransferModel = MongooseModule.forFeature([
  { name: TransferModelName, schema: TransferSchema },
]);
export type TransferDocument = HydratedDocument<Transfer>;
