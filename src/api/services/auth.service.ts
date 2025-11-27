import { PrismaRepository } from '@api/repository/repository.service';
import { BadRequestException } from '@exceptions';
import { withDbTimeout } from '@utils/async-timeout';

export class AuthService {
  constructor(private readonly prismaRepository: PrismaRepository) {}

  public async checkDuplicateToken(token: string) {
    if (!token) {
      return true;
    }

    // ✅ FIX: Wrap DB query with timeout to prevent hanging
    const instances = await withDbTimeout(
      this.prismaRepository.instance.findMany({
        where: { token },
      }),
      'auth:checkDuplicateToken',
    );

    if (instances.length > 0) {
      throw new BadRequestException('Token already exists');
    }

    return true;
  }
}
