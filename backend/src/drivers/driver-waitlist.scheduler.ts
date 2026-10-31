import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Events } from '../common/contracts';
import { DriverProfile } from '../database/entities';
import { DriverCoreService } from './driver-core.service';
import { zonesWithWaitlist } from './zone-capacity';

/**
 * Invites couriers off a zone's waiting list when places open: right away when staff change the zone's driver limit, and every 5 minutes for the
 * places that free up on their own (a driver is rejected, deactivated or leaves the zone). The longest-waiting couriers go first.
 */
@Injectable()
export class DriverWaitlistScheduler {
  private readonly logger = new Logger('DriverWaitlist');
  private running = false;

  constructor(
    private core: DriverCoreService,
    @InjectRepository(DriverProfile) private profiles: Repository<DriverProfile>,
  ) {}

  @OnEvent(Events.ZONE_CAPACITY_CHANGED)
  async onCapacityChanged(e: { zoneId: string }) {
    try {
      const n = await this.core.inviteFromWaitlist(e.zoneId);
      if (n) this.logger.log(`zone ${e.zoneId}: invited ${n} courier(s) off the waiting list`);
    } catch (err: any) {
      this.logger.error(`inviting from the waiting list failed for zone ${e.zoneId}: ${err.message}`);
    }
  }

  @Cron('0 */5 * * * *')
  async sweep() {
    if (this.running) return;
    this.running = true;
    try {
      for (const zoneId of await zonesWithWaitlist(this.profiles)) {
        const n = await this.core.inviteFromWaitlist(zoneId).catch((err: any) => (this.logger.error(`zone ${zoneId}: ${err.message}`), 0));
        if (n) this.logger.log(`zone ${zoneId}: invited ${n} courier(s) off the waiting list`);
      }
    } finally {
      this.running = false;
    }
  }
}
