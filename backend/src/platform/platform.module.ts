import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { City, CommissionTier, Cuisine, DriverProfile, Incident, MenuItem, OpsChecklist, Restaurant, TaxClass, Zone } from '../database/entities';
import { CommissionController, CommissionService } from './commission';
import { TaxClassesService, CommissionTiersService, CuisinesService, TaxClassesController, CommissionTiersController, CuisinesController, PublicCuisinesController } from './catalog';
import { GeographyService, CitiesController, ZonesController, PublicGeoController } from './geography';
import { IncidentsService, IncidentsController, PublicStatusController } from './incidents';
import { ChecklistsService, SupplyService, ChecklistsController, SupplyController } from './operations';
import { PlatformPricingService, PricingController } from './pricing';

/**
 * PlatformModule (ARCHITECTURE.md): cities/zones/tax classes/commission tiers/cuisines admin CRUD,
 * pricing & commission rules admin screens + simulator, incidents (SOP-10), ops checklists (SOP-03),
 * supply/demand forecast, and the public cities/cuisines/zones-resolve endpoints.
 *
 * catalog.ts / geography.ts / incidents.ts / operations.ts / pricing.ts are already fully implemented
 * (services + controllers); this module only needs to wire the TypeORM repositories they inject and
 * register the providers/controllers. AuditService, SettingsService, NotificationsService,
 * RealtimeService and GeoService are all @Global (CoreModule / AuditModule / SettingsModule /
 * NotificationsModule / RealtimeModule) so they do not need to be imported here.
 */
@Module({
  imports: [TypeOrmModule.forFeature([City, Zone, TaxClass, CommissionTier, Cuisine, Restaurant, DriverProfile, MenuItem, Incident, OpsChecklist])],
  providers: [TaxClassesService, CommissionTiersService, CuisinesService, GeographyService, IncidentsService, ChecklistsService, SupplyService, PlatformPricingService, CommissionService],
  controllers: [
    TaxClassesController,
    CommissionTiersController,
    CuisinesController,
    PublicCuisinesController,
    CitiesController,
    ZonesController,
    PublicGeoController,
    IncidentsController,
    PublicStatusController,
    ChecklistsController,
    SupplyController,
    PricingController,
    CommissionController,
  ],
  exports: [TaxClassesService, CommissionTiersService, CuisinesService, GeographyService, IncidentsService, ChecklistsService, SupplyService, PlatformPricingService, CommissionService],
})
export class PlatformModule {}
