import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsEnum, IsIn, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { VehicleType } from '../common/enums';
import { STORE_TYPES } from '../common/store-types';

const PW = { min: 8, max: 128 };

export class LoginDto {
  @IsString() @MaxLength(254) identifier: string; // email or phone
  @IsString() @MaxLength(PW.max) password: string;
  /** which app is logging in - used to reject wrong account types */
  @IsOptional() @IsIn(['admin', 'restaurant', 'driver', 'customer']) app?: 'admin' | 'restaurant' | 'driver' | 'customer';
  @IsOptional() @IsString() @MaxLength(200) deviceInfo?: string;
}

export class TwoFactorVerifyDto {
  @IsString() @MaxLength(2048) tempToken: string;
  @IsString() @Length(6, 6) @Matches(/^\d{6}$/) code: string;
}

export class TwoFactorEnableDto {
  @IsString() @Length(6, 6) @Matches(/^\d{6}$/) code: string;
}

export class RefreshDto {
  @IsString() @MaxLength(200) refreshToken: string;
}

export class ChangePasswordDto {
  @IsString() @MaxLength(PW.max) currentPassword: string;
  @IsString() @MinLength(PW.min) @MaxLength(PW.max) newPassword: string;
}

export class ForgotPasswordDto {
  @IsString() @MaxLength(254) identifier: string;
}

export class ResetPasswordDto {
  @IsString() @MaxLength(254) identifier: string;
  @IsString() @MaxLength(12) code: string;
  @IsString() @MinLength(PW.min) @MaxLength(PW.max) newPassword: string;
}

export class OtpRequestDto {
  @IsString() @MaxLength(30) phone: string;
  @IsOptional() @IsIn(['customer', 'driver', 'restaurant']) app?: 'customer' | 'driver' | 'restaurant';
}

export class OtpVerifyDto {
  @IsString() @MaxLength(30) phone: string;
  @IsString() @Length(4, 8) code: string;
  @IsOptional() @IsIn(['customer', 'driver', 'restaurant']) app?: 'customer' | 'driver' | 'restaurant';
  /** when the phone is new, these create a customer account */
  @IsOptional() @IsString() @MaxLength(80) firstName?: string;
  @IsOptional() @IsString() @MaxLength(80) lastName?: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsString() @MaxLength(20) referralCode?: string;
  @IsOptional() @IsString() @MaxLength(200) deviceInfo?: string;
}

export class CustomerRegisterDto {
  @IsString() @MaxLength(80) firstName: string;
  @IsString() @MaxLength(80) lastName: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @IsString() @MinLength(PW.min) @MaxLength(PW.max) password: string;
  @IsOptional() @IsString() @MaxLength(20) referralCode?: string;
  @IsOptional() @IsBoolean() marketingEmailConsent?: boolean;
  @IsOptional() @IsBoolean() marketingSmsConsent?: boolean;
  @IsOptional() @IsString() @MaxLength(10) language?: string;
}

export class SocialLoginDto {
  @IsIn(['google', 'apple']) provider: 'google' | 'apple';
  @IsString() @MaxLength(4096) idToken: string;
  @IsOptional() @IsString() @MaxLength(80) firstName?: string;
  @IsOptional() @IsString() @MaxLength(80) lastName?: string;
  @IsOptional() @IsString() @MaxLength(20) referralCode?: string;
}

export class DriverRegisterDto {
  @IsString() @MaxLength(80) firstName: string;
  @IsString() @MaxLength(80) lastName: string;
  @IsString() @MaxLength(30) phone: string;
  @IsEmail() @MaxLength(254) email: string;
  @IsString() @MinLength(PW.min) @MaxLength(PW.max) password: string;
  /** phone OTP obtained from /auth/otp/request (purpose SIGNUP) */
  @IsString() @MaxLength(12) otpCode: string;
  @IsUUID() cityId: string;
  /** the local zone the courier works in (picked, or detected from their location); switched on for them once their account is approved */
  @IsOptional() @IsUUID() zoneId?: string;
  @IsEnum(VehicleType) vehicleType: VehicleType;
  @IsOptional() @IsString() @MaxLength(60) vehicleMake?: string;
  @IsOptional() @IsString() @MaxLength(60) vehicleModel?: string;
  @IsOptional() @IsString() @MaxLength(40) vehicleColor?: string;
  @IsOptional() @IsString() @MaxLength(20) licensePlate?: string;
  @IsOptional() @IsString() @MaxLength(10) language?: string;
}

export class RestaurantApplyDto {
  // owner
  @IsString() @MaxLength(80) ownerFirstName: string;
  @IsString() @MaxLength(80) ownerLastName: string;
  @IsEmail() @MaxLength(254) email: string;
  @IsString() @MaxLength(30) phone: string;
  @IsString() @MinLength(PW.min) @MaxLength(PW.max) password: string;
  // business
  @IsString() @MaxLength(150) businessName: string;
  @IsOptional() @IsString() @MaxLength(150) legalName?: string;
  @IsOptional() @IsString() @MaxLength(40) hstNumber?: string;
  // location
  @IsString() @MaxLength(150) restaurantName: string;
  @IsString() @MaxLength(200) addressLine1: string;
  @IsOptional() @IsString() @MaxLength(200) addressLine2?: string;
  @IsString() @MaxLength(80) city: string;
  @IsOptional() @IsString() @MaxLength(40) province?: string;
  @IsString() @MaxLength(12) postalCode: string;
  @IsOptional() @IsNumber() @Min(-90) @Max(90) lat?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) lng?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID('all', { each: true }) cuisineIds?: string[];
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsUUID() cityId?: string;
  @IsOptional() @IsBoolean() pickupEnabled?: boolean;
  @IsOptional() @IsBoolean() deliveryEnabled?: boolean;
  /** RESTAURANT (default), CAFE, BAKERY, GROCERY, CONVENIENCE or SPECIALTY: decides the documents asked for and how the store works (docs/store-types.md) */
  @IsOptional() @IsIn(STORE_TYPES) storeType?: string;
}
