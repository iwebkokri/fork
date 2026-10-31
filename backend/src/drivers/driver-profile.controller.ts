import { Body, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { CurrentUser, DriverController } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { DriverAppService } from './driver-app.service';
import {
  BankDto,
  DriverZonesDto,
  GoOnlineDto,
  LocationDto,
  QuizSubmitDto,
  ReplaceDocumentDto,
  TaxInfoDto,
  UpdateProfileDto,
  UploadDocumentDto,
} from './drivers.dto';

/** Driver-app profile, documents, bank/tax, training, checklist, online/offline & location (spec §5). */
@DriverController('')
export class DriverProfileController {
  constructor(private app: DriverAppService) {}

  @Get('profile')
  profile(@CurrentUser() user: AuthUser) {
    return this.app.profile(user.driverId!);
  }

  @Patch('profile')
  updateProfile(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.app.updateProfile(user.driverId!, dto);
  }

  @Post('notice/ack')
  ackNotice(@CurrentUser() user: AuthUser) {
    return this.app.ackNotice(user.driverId!);
  }

  @Get('checklist')
  checklist(@CurrentUser() user: AuthUser) {
    return this.app.checklist(user.driverId!);
  }

  @Get('documents')
  documents(@CurrentUser() user: AuthUser) {
    return this.app.listDocuments(user.driverId!);
  }

  @Post('documents')
  uploadDocument(@CurrentUser() user: AuthUser, @Body() dto: UploadDocumentDto) {
    return this.app.uploadDocument(user.driverId!, dto);
  }

  @Patch('documents/:id')
  replaceDocument(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReplaceDocumentDto) {
    return this.app.replaceDocument(user.driverId!, id, dto);
  }

  @Put('bank')
  setBank(@CurrentUser() user: AuthUser, @Body() dto: BankDto) {
    return this.app.setBank(user.driverId!, dto);
  }

  @Put('tax')
  setTax(@CurrentUser() user: AuthUser, @Body() dto: TaxInfoDto) {
    return this.app.setTax(user.driverId!, dto);
  }

  @Get('training')
  training(@CurrentUser() user: AuthUser) {
    return this.app.training(user.driverId!);
  }

  @Post('training/:moduleId/quiz')
  submitQuiz(@CurrentUser() user: AuthUser, @Param('moduleId') moduleId: string, @Body() dto: QuizSubmitDto) {
    return this.app.submitQuiz(user.driverId!, moduleId, dto);
  }

  @Get('zones')
  zones(@CurrentUser() user: AuthUser) {
    return this.app.myZones(user.driverId!);
  }

  @Post('zones/:zoneId')
  joinZone(@CurrentUser() user: AuthUser, @Param('zoneId', ParseUUIDPipe) zoneId: string) {
    return this.app.joinZone(user.driverId!, zoneId);
  }

  @Delete('zones/:zoneId')
  leaveZone(@CurrentUser() user: AuthUser, @Param('zoneId', ParseUUIDPipe) zoneId: string) {
    return this.app.leaveZone(user.driverId!, zoneId);
  }

  @Put('zones')
  setZones(@CurrentUser() user: AuthUser, @Body() dto: DriverZonesDto) {
    return this.app.setZones(user.driverId!, dto.zoneIds);
  }

  @Post('online')
  goOnline(@CurrentUser() user: AuthUser, @Body() dto: GoOnlineDto) {
    return this.app.goOnline(user.driverId!, dto);
  }

  @Post('offline')
  goOffline(@CurrentUser() user: AuthUser) {
    return this.app.goOffline(user.driverId!);
  }

  @Post('location')
  location(@CurrentUser() user: AuthUser, @Body() dto: LocationDto) {
    return this.app.location(user.driverId!, dto);
  }
}
