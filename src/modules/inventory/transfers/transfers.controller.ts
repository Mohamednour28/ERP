import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Query,
} from '@nestjs/common';
import { TransfersService } from './transfers.service';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { PermissionsGuard } from 'src/common/guards/permissions.guard';
import { RequirePermissions } from 'src/common/decorators/permissions.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';

@Controller('inventory/transfers')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TransfersController {
  constructor(private readonly transfersService: TransfersService) {}

  @Post()
  @RequirePermissions('edit:inventory')
  async create(
    @Body() createTransferDto: any,
    @CurrentUser('id') userId: string,
  ) {
    return this.transfersService.create(createTransferDto, userId);
  }

  @Get()
  @RequirePermissions('view:inventory')
  async findAll(@Query() query: any) {
    return this.transfersService.findAll(query);
  }

  @Get(':id')
  @RequirePermissions('view:inventory')
  async findOne(@Param('id') id: string) {
    return this.transfersService.findOne(id);
  }

  /** PATCH /:id — generic update OR post when body contains { status: "Posted" } */
  @Patch(':id')
  @RequirePermissions('edit:inventory')
  async update(
    @Param('id') id: string,
    @Body() updateTransferDto: any,
    @CurrentUser('id') userId: string,
  ) {
    return this.transfersService.update(id, updateTransferDto, userId);
  }

  /** PUT /:id — same as PATCH */
  @Put(':id')
  @RequirePermissions('edit:inventory')
  async replace(
    @Param('id') id: string,
    @Body() updateTransferDto: any,
    @CurrentUser('id') userId: string,
  ) {
    return this.transfersService.update(id, updateTransferDto, userId);
  }

  /** POST /:id/post — explicit posting endpoint (executes stock movement) */
  @Post(':id/post')
  @RequirePermissions('edit:inventory')
  async post(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.transfersService.update(id, { status: 'Posted' }, userId);
  }

  /** POST /:id/cancel — cancel a transfer */
  @Post(':id/cancel')
  @RequirePermissions('edit:inventory')
  async cancel(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.transfersService.cancel(id, userId);
  }

  @Delete(':id')
  @RequirePermissions('edit:inventory')
  async remove(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.transfersService.remove(id, userId);
  }
}
