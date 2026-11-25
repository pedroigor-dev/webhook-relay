import { createApplication } from './app';

async function bootstrap() {
  const app = await createApplication();
  await app.listen(
    Number(process.env.PORT ?? 4312),
    process.env.HOST ?? '0.0.0.0',
  );
}

bootstrap().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
