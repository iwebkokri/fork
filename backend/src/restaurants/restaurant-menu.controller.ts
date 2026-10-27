import { Body, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, RestaurantController, RestaurantRoles } from '../common/decorators';
import { RestaurantRole } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { MenuService } from './menu.service';
import { MenuAccessService } from './menu-access.service';
import { resolveRestaurantId } from './restaurants.util';
import {
  CategoryDto,
  EightySixDto,
  MenuAccessRequestDto,
  ItemDto,
  ModifierGroupDto,
  ModifierOptionDto,
  PrepTargetsDto,
  ProductListQuery,
  ReorderDto,
  SetGroupsDto,
  StockUpdateDto,
  UpdateCategoryDto,
  UpdateGroupDto,
  UpdateItemDto,
  UpdateOptionDto,
} from './dto';

const MANAGERS = [RestaurantRole.OWNER, RestaurantRole.LOCATION_MANAGER];

/** Full menu management (spec §4.3): categories, items, modifier groups/options, combos, dayparts, 86/restock. (CSV import / export is admin-only: /admin/restaurants/:id/menu/export|import.) */
@RestaurantController('menu')
export class RestaurantMenuController {
  constructor(private menu: MenuService, private access: MenuAccessService) {}

  private rid(user: AuthUser, restaurantId?: string) {
    return resolveRestaurantId(user, restaurantId);
  }

  /** the resolved restaurant, after checking that FORKSY allows this restaurant to change its menu */
  private async edit(user: AuthUser, restaurantId?: string) {
    const id = this.rid(user, restaurantId);
    await this.access.assertCanEdit(id, user);
    return id;
  }

  @Get()
  async tree(@CurrentUser() user: AuthUser, @Query('restaurantId') restaurantId?: string, @Query('includeInactive') includeInactive?: string, @Query('items') items?: string) {
    const id = this.rid(user, restaurantId);
    // items=false: the structure only (departments with their product counts): for stores whose products are loaded page by page (GET /restaurant/menu/items)
    const [tree, access] = await Promise.all([items === 'false' ? this.menu.structure(id) : this.menu.tree(id, includeInactive !== 'false'), this.access.access(id)]);
    return { ...tree, access };
  }

  /** Paged, searchable product list (catalog screen of grocery / retail stores; works for any store). */
  @Get('items')
  listItems(@CurrentUser() user: AuthUser, @Query() q: ProductListQuery) {
    return this.menu.listItems(this.rid(user, q.restaurantId), q as Record<string, string | undefined>);
  }

  /** Stock counts, deliveries and POS syncs: set or adjust the stock of many products by id, SKU or barcode. Not menu editing (prices stay as they are). */
  @Post('stock')
  @RestaurantRoles(...MANAGERS, RestaurantRole.CASHIER)
  stockUpdate(@CurrentUser() user: AuthUser, @Body() dto: StockUpdateDto, @Query('restaurantId') restaurantId?: string) {
    return this.menu.stockUpdate(this.rid(user, restaurantId), dto.updates);
  }

  /** Can this restaurant add / update / remove menu items? (decided by FORKSY staff) */
  @Get('access')
  menuAccess(@CurrentUser() user: AuthUser, @Query('restaurantId') restaurantId?: string) {
    return this.access.access(this.rid(user, restaurantId));
  }

  /** Ask FORKSY staff for permission to edit the menu. */
  @Post('access/request')
  @RestaurantRoles(...MANAGERS)
  requestAccess(@CurrentUser() user: AuthUser, @Body() dto: MenuAccessRequestDto, @Query('restaurantId') restaurantId?: string) {
    return this.access.request(this.rid(user, restaurantId), dto.note, user);
  }

  // ---- categories ----
  @Post('categories')
  @RestaurantRoles(...MANAGERS)
  async createCategory(@CurrentUser() user: AuthUser, @Body() dto: CategoryDto, @Query('restaurantId') restaurantId?: string) {
    return this.menu.createCategory(await this.edit(user, restaurantId), dto);
  }

  @Patch('categories/reorder')
  @RestaurantRoles(...MANAGERS)
  async reorderCategories(@CurrentUser() user: AuthUser, @Body() dto: ReorderDto, @Query('restaurantId') restaurantId?: string) {
    return this.menu.reorderCategories(await this.edit(user, restaurantId), dto.ids);
  }

  @Patch('categories/:id')
  @RestaurantRoles(...MANAGERS)
  async updateCategory(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateCategoryDto, @Query('restaurantId') restaurantId?: string) {
    return this.menu.updateCategory(await this.edit(user, restaurantId), id, dto);
  }

  @Delete('categories/:id')
  @RestaurantRoles(...MANAGERS)
  async deleteCategory(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('restaurantId') restaurantId?: string, @Query('moveItemsTo') moveItemsTo?: string) {
    return this.menu.deleteCategory(await this.edit(user, restaurantId), id, moveItemsTo);
  }

  // ---- items ----
  @Post('items')
  @RestaurantRoles(...MANAGERS)
  async createItem(@CurrentUser() user: AuthUser, @Body() dto: ItemDto, @Query('restaurantId') restaurantId?: string) {
    return this.menu.createItem(await this.edit(user, restaurantId), dto);
  }

  @Patch('items/reorder')
  @RestaurantRoles(...MANAGERS)
  async reorderItems(@CurrentUser() user: AuthUser, @Body() dto: ReorderDto, @Query('restaurantId') restaurantId?: string) {
    return this.menu.reorderItems(await this.edit(user, restaurantId), dto.ids);
  }

  @Get('items/:id')
  getItem(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('restaurantId') restaurantId?: string) {
    return this.menu.getItem(this.rid(user, restaurantId), id);
  }

  @Patch('items/:id')
  @RestaurantRoles(...MANAGERS)
  async updateItem(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateItemDto, @Query('restaurantId') restaurantId?: string) {
    return this.menu.updateItem(await this.edit(user, restaurantId), id, dto);
  }

  @Delete('items/:id')
  @RestaurantRoles(...MANAGERS)
  async deleteItem(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('restaurantId') restaurantId?: string) {
    return this.menu.deleteItem(await this.edit(user, restaurantId), id);
  }

  @Post('items/:id/groups')
  @RestaurantRoles(...MANAGERS)
  async setItemGroups(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: SetGroupsDto, @Query('restaurantId') restaurantId?: string) {
    return this.menu.setItemGroups(await this.edit(user, restaurantId), id, dto.groupIds);
  }

  @Post('items/:id/86')
  @RestaurantRoles(...MANAGERS, RestaurantRole.CASHIER, RestaurantRole.KITCHEN)
  eightySixItem(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: EightySixDto, @Query('restaurantId') restaurantId?: string) {
    return this.menu.eightySix(this.rid(user, restaurantId), id, dto);
  }

  @Post('items/:id/restock')
  @RestaurantRoles(...MANAGERS, RestaurantRole.CASHIER, RestaurantRole.KITCHEN)
  restockItem(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('restaurantId') restaurantId?: string) {
    return this.menu.restockItem(this.rid(user, restaurantId), id);
  }

  // ---- modifier groups & options ----
  @Post('groups')
  @RestaurantRoles(...MANAGERS)
  async createGroup(@CurrentUser() user: AuthUser, @Body() dto: ModifierGroupDto, @Query('restaurantId') restaurantId?: string) {
    return this.menu.createGroup(await this.edit(user, restaurantId), dto);
  }

  @Get('groups/:id')
  getGroup(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('restaurantId') restaurantId?: string) {
    return this.menu.getGroup(this.rid(user, restaurantId), id);
  }

  @Patch('groups/:id')
  @RestaurantRoles(...MANAGERS)
  async updateGroup(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateGroupDto, @Query('restaurantId') restaurantId?: string) {
    return this.menu.updateGroup(await this.edit(user, restaurantId), id, dto);
  }

  @Delete('groups/:id')
  @RestaurantRoles(...MANAGERS)
  async deleteGroup(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('restaurantId') restaurantId?: string) {
    return this.menu.deleteGroup(await this.edit(user, restaurantId), id);
  }

  @Post('groups/:id/items/:itemId')
  @RestaurantRoles(...MANAGERS)
  async attachGroup(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('itemId') itemId: string, @Query('restaurantId') restaurantId?: string) {
    return this.menu.attachGroup(await this.edit(user, restaurantId), itemId, id);
  }

  @Delete('groups/:id/items/:itemId')
  @RestaurantRoles(...MANAGERS)
  async detachGroup(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('itemId') itemId: string, @Query('restaurantId') restaurantId?: string) {
    return this.menu.detachGroup(await this.edit(user, restaurantId), itemId, id);
  }

  @Post('groups/:id/options')
  @RestaurantRoles(...MANAGERS)
  async createOption(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ModifierOptionDto, @Query('restaurantId') restaurantId?: string) {
    return this.menu.createOption(await this.edit(user, restaurantId), id, dto);
  }

  @Patch('options/:id')
  @RestaurantRoles(...MANAGERS)
  async updateOption(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateOptionDto, @Query('restaurantId') restaurantId?: string) {
    return this.menu.updateOption(await this.edit(user, restaurantId), id, dto);
  }

  @Delete('options/:id')
  @RestaurantRoles(...MANAGERS)
  async deleteOption(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('restaurantId') restaurantId?: string) {
    return this.menu.deleteOption(await this.edit(user, restaurantId), id);
  }

  @Post('options/:id/86')
  @RestaurantRoles(...MANAGERS, RestaurantRole.CASHIER, RestaurantRole.KITCHEN)
  eightySixOption(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: EightySixDto, @Query('restaurantId') restaurantId?: string) {
    return this.menu.eightySixOption(this.rid(user, restaurantId), id, dto);
  }

  @Post('options/:id/restock')
  @RestaurantRoles(...MANAGERS, RestaurantRole.CASHIER, RestaurantRole.KITCHEN)
  restockOption(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('restaurantId') restaurantId?: string) {
    return this.menu.restockOption(this.rid(user, restaurantId), id);
  }

  // ---- prep targets ----
  @Get('prep-targets')
  prepTargets(@CurrentUser() user: AuthUser, @Query('restaurantId') restaurantId?: string) {
    return this.menu.prepTargets(this.rid(user, restaurantId));
  }

  @Post('prep-targets')
  @RestaurantRoles(...MANAGERS)
  setPrepTargets(@CurrentUser() user: AuthUser, @Body() dto: PrepTargetsDto, @Query('restaurantId') restaurantId?: string) {
    return this.menu.setPrepTargets(this.rid(user, restaurantId), dto.targets);
  }
}
