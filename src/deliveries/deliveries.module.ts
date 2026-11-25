import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ApiKeyGuard } from '../security/api-key.guard';
import { DeliveriesController } from './deliveries.controller';
import { Deliveries } from './deliveries.service';

@Module({
  imports: [DatabaseModule],
  controllers: [DeliveriesController],
  providers: [Deliveries, ApiKeyGuard],
})
export class DeliveriesModule {}
