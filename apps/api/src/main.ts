import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap(): Promise<void> {
  const port = Number(process.env.ARCHGUARD_API_PORT ?? 3001)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('ARCHGUARD_API_PORT 应为 1 到 65535 之间的整数。')
  }
  const app = await NestFactory.create(AppModule)
  app.enableShutdownHooks()
  app.setGlobalPrefix('api')
  await app.listen(port, '127.0.0.1')
}

bootstrap().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
