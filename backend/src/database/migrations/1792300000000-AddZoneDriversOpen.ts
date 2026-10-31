import { MigrationInterface, QueryRunner } from "typeorm";

export class AddZoneDriversOpen1792300000000 implements MigrationInterface {
    name = 'AddZoneDriversOpen1792300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "zones" ADD "driversOpen" boolean NOT NULL DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "zones" DROP COLUMN "driversOpen"`);
    }

}
