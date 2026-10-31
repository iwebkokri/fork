import { Body, Get, Headers, Param, Post } from '@nestjs/common';
import { ClientIp, CurrentUser, DriverController } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { DriverAppService } from './driver-app.service';
import { CallDto, DeclineOfferDto, DeliverDto, PickupDto, StepDto } from './drivers.dto';

/** Current offer (via Dispatch) + active trip status steps (spec §5.2/5.3: arrived -> picked up -> arrived -> delivered). */
@DriverController('trip')
export class DriverTripController {
  constructor(private app: DriverAppService) {}

  @Get('offer')
  currentOffer(@CurrentUser() user: AuthUser) {
    return this.app.currentOffer(user.driverId!);
  }

  @Post('offer/:offerId/accept')
  acceptOffer(@CurrentUser() user: AuthUser, @Param('offerId') offerId: string) {
    return this.app.acceptOffer(user.driverId!, offerId);
  }

  @Post('offer/:offerId/decline')
  declineOffer(@CurrentUser() user: AuthUser, @Param('offerId') offerId: string, @Body() dto: DeclineOfferDto) {
    return this.app.declineOffer(user.driverId!, offerId, dto);
  }

  @Get('active')
  activeTrip(@CurrentUser() user: AuthUser) {
    return this.app.activeTrip(user.driverId!);
  }

  @Post(':orderId/still-here')
  stillHere(@CurrentUser() user: AuthUser, @Param('orderId') orderId: string) {
    return this.app.confirmPresence(user.driverId!, orderId);
  }

  @Post(':orderId/arrived-restaurant')
  arrivedRestaurant(@CurrentUser() user: AuthUser, @Param('orderId') orderId: string, @Body() dto: StepDto) {
    return this.app.arrivedRestaurant(user.driverId!, orderId, dto);
  }

  @Post(':orderId/picked-up')
  pickedUp(@CurrentUser() user: AuthUser, @Param('orderId') orderId: string, @Body() dto: PickupDto) {
    return this.app.pickedUp(user.driverId!, orderId, dto);
  }

  @Post(':orderId/arrived-customer')
  arrivedCustomer(@CurrentUser() user: AuthUser, @Param('orderId') orderId: string, @Body() dto: StepDto) {
    return this.app.arrivedCustomer(user.driverId!, orderId, dto);
  }

  @Post(':orderId/delivered')
  delivered(@CurrentUser() user: AuthUser, @Param('orderId') orderId: string, @Body() dto: DeliverDto, @ClientIp() ip: string, @Headers('user-agent') userAgent?: string) {
    return this.app.delivered(user.driverId!, orderId, dto, { ip, userAgent });
  }

  @Post(':orderId/call')
  call(@CurrentUser() user: AuthUser, @Param('orderId') orderId: string, @Body() dto: CallDto) {
    return this.app.maskedCall(user.driverId!, orderId, dto);
  }
}
