import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMenuItemDetails1792250000000 implements MigrationInterface {
    name = 'AddMenuItemDetails1792250000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "menu_items"
            ADD "spiceLevel" character varying(10),
            ADD "lengthCm" numeric(12,3),
            ADD "widthCm" numeric(12,3),
            ADD "heightCm" numeric(12,3),
            ADD "ingredients" text,
            ADD "mayContain" jsonb NOT NULL DEFAULT '[]',
            ADD "nutrition" jsonb,
            ADD "servingSize" character varying(60),
            ADD "countryOfOrigin" character varying(60),
            ADD "storage" character varying(200)
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "menu_items"
            DROP COLUMN "spiceLevel", DROP COLUMN "lengthCm", DROP COLUMN "widthCm", DROP COLUMN "heightCm", DROP COLUMN "ingredients",
            DROP COLUMN "mayContain", DROP COLUMN "nutrition", DROP COLUMN "servingSize", DROP COLUMN "countryOfOrigin", DROP COLUMN "storage"
        `);
    }

}
