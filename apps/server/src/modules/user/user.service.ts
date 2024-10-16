import type {
  Account,
  IListQueryDto,
  IListQueryResult,
  IUser,
  IUserFull,
  IUserProfile,
  Prisma,
  Resource,
  TAccountProvider,
} from '@xsin/xboard'
import type { CreateUserDto } from './dto/create.dto'
import type { UpdateUserDto } from './dto/update.dto'
import { buildFindManyParams } from '@/common/utils'
import { saltAndHashPassword } from '@/common/utils/password'
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { XBError } from '@xsin/xboard'
import { isEmpty, omit } from 'radash'
import { AccountService } from '../account/account.service'
import { CreateAccountDto } from '../account/dto/create.dto'
import { UpdateAccountDto } from '../account/dto/update.dto'
import { AppConfigService } from '../config/config.service'
import { PrismaService } from '../prisma/prisma.service'
import {
  UserColumns,
} from './dto/user.dto'

@Injectable()
export class UserService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly accountService: AccountService,
    private readonly configService: AppConfigService,
  ) {}

  async create(createUserDto: CreateUserDto, accountDto: CreateAccountDto): Promise<IUser> {
    const user = await this.findByEmail(createUserDto.email)
    if (user) {
      throw new ConflictException('User already exists')
    }
    // remove password1 from createUserDto
    const {
      password1,
      ...userDto
    } = createUserDto

    const defaultRoleId = this.configService.NB_DEFAULT_ROLE_ID
    const newUser = await this.prismaService.user.create({
      data: {
        ...userDto,
        password: await saltAndHashPassword(createUserDto.password),
        accounts: {
          create: {
            ...accountDto,
          },
        },
        roles: {
          create: {
            role: {
              connect: {
                id: defaultRoleId,
              },
            },
          },
        },
      },
      select: UserColumns,
    })

    return newUser
  }

  async findAll(dto: IListQueryDto): Promise<IListQueryResult<IUser>> {
    const findManyParams = buildFindManyParams<Prisma.UserFindManyArgs>(dto)

    const items = await this.prismaService.user.findMany(findManyParams)

    const total = await this.prismaService.user.count({ where: findManyParams.where })

    return {
      items,
      total,
      page: dto.page,
      limit: dto.limit,
    }
  }

  async findOne(id: string): Promise<IUser> {
    return this.prismaService.user.findUnique({
      where: {
        id,
      },
      select: UserColumns,
    })
  }

  async findByEmail(email: string): Promise<IUser> {
    const item = this.prismaService.user.findUnique({
      where: {
        email,
      },
      select: UserColumns,
    })
    return item
  }

  /**
   * Find the user data, includes user's roles, the permissions and the authorized resources associated with those roles.
   * @param {Prisma.UserWhereUniqueInput} whereArgs - User where unique input
   * @param {boolean} includeResources - Whether to include the authorized resources
   * @returns {Promise<IUserWithRolesPermissionsAndMenus>} user with roles, permissions and visible menus
   */
  async findUser(whereArgs: Prisma.UserWhereUniqueInput, includeResources: boolean = true): Promise<IUserFull> {
    const user = await this.prismaService.user.findUnique({
      where: whereArgs,
      include: {
        roles: {
          include: {
            role: {
              include: {
                permissions: {
                  include: {
                    permission: true,
                  },
                },
              },
            },
          },
        },
      },
    })
    if (!user) {
      return null
    }
    const userInfo = omit(user, ['roles'])
    const roles = user.roles.map(userRole => userRole.role)
    const roleNames = roles.map(role => role.name)
    const permissions = roles.flatMap(role => role.permissions.map(rolePermission => rolePermission.permission))
    const permissionNames = permissions.map(permission => permission.name)
    const item: IUserFull = {
      ...userInfo,
      roles,
      roleNames,
      permissions,
      permissionNames,
      resources: [],
    }

    if (includeResources) {
      item.resources = await this.parseUserResources(item)
    }

    return item
  }

  /**
   * Find full user data by email. Including the user's roles, password, permissions, and the authorized resources associated with those roles.
   * @param {string} email user's email
   * @param {boolean} includeResources - Whether to include the authorized resources
   * @returns {Promise<IUserFull>} user with roles, password, permissions and the authorized resources
   */
  async findByEmailX(email: string, includeResources: boolean = true): Promise<IUserFull> {
    return this.findUser({ email }, includeResources)
  }

  /**
   * Find full user data by id. Including the user's roles, password, permissions, and the authorized resources associated with those roles.
   * @param {string} id user's id
   * @param {boolean} includeResources - Whether to include the authorized resources
   * @returns {Promise<IUserFull>} user with roles, password, permissions and the authorized resources
   */
  async findByIdX(id: string, includeResources: boolean = true): Promise<IUserFull> {
    return this.findUser({ id }, includeResources)
  }

  async update(id: string, updateUserDto: UpdateUserDto): Promise<IUser> {
    if (isEmpty(id)) {
      throw new BadRequestException(XBError.INVALID_PARAMETERS)
    }

    // process password
    if (updateUserDto.password && updateUserDto.password1 && updateUserDto.password === updateUserDto.password1) {
      updateUserDto.password = await saltAndHashPassword(updateUserDto.password)
    }

    // remove password1 from updateUserDto
    const {
      password1,
      ...userDto
    } = updateUserDto

    return this.prismaService.user.update({
      where: {
        id,
      },
      data: userDto,
      select: UserColumns,
    })
  }

  async remove(id: string): Promise<IUser> {
    return this.prismaService.user.delete({
      where: {
        id,
      },
      select: UserColumns,
    })
  }

  async verifyEmail(email: string): Promise<IUser> {
    const user = await this.findByEmail(email)
    if (!user) {
      throw new ConflictException('User not found')
    }

    // Whether is already verified
    if (user.emailVerifiedAt) {
      return user
    }

    return this.prismaService.user.update({
      where: {
        id: user.id,
      },
      data: {
        emailVerifiedAt: new Date(),
      },
      select: UserColumns,
    })
  }

  /**
   * Get User's resources according to the user's permission and resource's permission
   * @param {string} email - User email
   */
  async findUserResources(email: string): Promise<IListQueryResult<Resource>> {
    // Find the user and his/her roles and permissions
    const user = await this.findByEmailX(email)

    if (!user) {
      throw new NotFoundException('User not found')
    }

    // Calculate user's total permission value on each menu
    const itemsWithPermissions = user.resources ?? []

    return {
      items: itemsWithPermissions,
      total: itemsWithPermissions.length,
      page: 1,
      limit: itemsWithPermissions.length,
    }
  }

  /**
   * Get User's resources according to the user's permission and resource's permission
   * 1. Find users and their roles and permissions: Search for users by their email and include the user's roles and the permissions associated with those roles.
   * 2. Find resources: Look up corresponding resources based on the permissions.
   * @param {IUser} user - User object with roles and permissions
   * @returns {Promise<Resource[]>} List of menus with user's permission code
   */
  private async parseUserResources(user: IUser): Promise<Resource[]> {
    const permissionsOwned = user.permissions ?? []

    // Get the IDs and codes of the filtered permissions
    const permissionIdsOwned = permissionsOwned.map(permission => permission.id)

    // Find the authorized resources
    const itemsViewable = await this.prismaService.resource.findMany({
      where: {
        permissions: {
          some: {
            permissionId: { in: permissionIdsOwned },
          },
        },
      },
    })

    return itemsViewable as Resource[]
  }

  /**
   * Get user's profile by email
   * @param {string} email - User email
   * @returns {Promise<IUserProfile>} User profile
   */
  async getUserProfileByEmail(email: string): Promise<IUserProfile> {
    return this.getUserProfile({ email })
  }

  async getUserProfileById(id: string): Promise<IUserProfile> {
    return this.getUserProfile({ id })
  }

  private async getUserProfile(where: Prisma.UserWhereUniqueInput): Promise<IUserProfile> {
    const userInfo = await this.findUser(where)
    const profile: IUserProfile = {
      id: userInfo.id,
      name: userInfo.name,
      displayName: userInfo.displayName,
      createdAt: userInfo.createdAt,
      updatedAt: userInfo.updatedAt,
      roleNames: userInfo.roleNames,
      permissionNames: userInfo.permissionNames,
      email: userInfo.email,
      emailVerifiedAt: userInfo.emailVerifiedAt,
      avatar: userInfo.avatar,
      gender: userInfo.gender,
      birthday: userInfo.birthday,
      loginAt: userInfo.loginAt,
    }
    return profile
  }

  getItemCacheKey(...idLikes: string[]): string {
    const id = idLikes.join(':')
    return `user:${id}`
  }

  // Account related methods
  async updateAccount(provider: TAccountProvider, providerAccountId: string, dto: UpdateAccountDto): Promise<Account> {
    return this.accountService.update(provider, providerAccountId, dto)
  }
}
