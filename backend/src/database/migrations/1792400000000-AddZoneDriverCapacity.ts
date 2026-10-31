import { MigrationInterface, QueryRunner } from "typeorm";

export class AddZoneDriverCapacity1792400000000 implements MigrationInterface {
    name = 'AddZoneDriverCapacity1792400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "zones" ADD "driverCapacity" integer`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "zones" DROP COLUMN "driverCapacity"`);
    }

}
