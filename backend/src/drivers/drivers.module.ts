import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  City,
  DriverDocument,
  DriverLocationLog,
  DriverOffer,
  DriverProfile,
  DriverShift,
  Incentive,
  LedgerEntry,
  Order,
  Review,
  ReviewCase,
  SosAlert,
  TrainingAttempt,
  TrainingModule,
  User,
  Zone,
} from '../database/entities';
import { CertnAdapter } from './adapters/certn.adapter';
import { MaskedCallAdapter } from './adapters/masked-call.adapter';
import { DriverCoreService } from './driver-core.service';
import { DriversAdminService } from './drivers-admin.service';
import { DriverOpsService } from './driver-ops.service';
import { DriverAppService } from './driver-app.service';
import { DriverExpiryScheduler } from './driver-scheduler.service';
import { DriverPresenceService } from './driver-presence.service';
import { DriverWaitlistScheduler } from './driver-waitlist.scheduler';
import { AdminDriversController } from './admin-drivers.controller';
import { DriverProfileController } from './driver-profile.controller';
import { DriverTripController } from './driver-trip.controller';
import { DriverEarningsController } from './driver-earnings.controller';

/**
 * DriversModule (ARCHITECTURE.md): admin drivers CRUD + SOP-02 application pipeline, incentives/boosts,
 * shifts, training modules, driver performance, earnings view, SOS admin, supply alerts, heat-map, and
 * the `/driver/*` app surface (profile, documents, bank/tax, training+quiz, online/offline, location,
 * offers via DispatchService, active trip via OrdersService, earnings via LedgerService, instant cash-out
 * via PayoutsService, shifts/incentives/ratings/SOS/masked-call). Not @Global - nothing outside this module
 * needs to inject a Drivers service directly; other modules read/write DriverProfile via their own repositories.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      DriverProfile,
      DriverDocument,
      DriverShift,
      DriverOffer,
      Incentive,
      TrainingModule,
      TrainingAttempt,
      SosAlert,
      DriverLocationLog,
      User,
      Order,
      LedgerEntry,
      ReviewCase,
      Review,
      Zone,
      City,
    ]),
  ],
  providers: [CertnAdapter, MaskedCallAdapter, DriverCoreService, DriversAdminService, DriverOpsService, DriverAppService, DriverExpiryScheduler, DriverPresenceService, DriverWaitlistScheduler],
  // the Certn result webhook lives in the VerificationModule (it settles drivers and businesses alike)
  controllers: [AdminDriversController, DriverProfileController, DriverTripController, DriverEarningsController],
  exports: [DriverCoreService, DriversAdminService, DriverOpsService, CertnAdapter],
})
export class DriversModule {}
