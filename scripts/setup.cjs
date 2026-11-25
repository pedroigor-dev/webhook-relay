const fs = require('node:fs');
const crypto = require('node:crypto');
if (fs.existsSync('.env')) {
  console.log('.env já existe; configuração preservada.');
} else {
  const text = fs
    .readFileSync('.env.example', 'utf8')
    .replace(
      /^(API_KEY|JWT_SECRET|BOOTSTRAP_KEY|WEBHOOK_SECRET)=$/gm,
      (_, key) => key + '=' + crypto.randomBytes(32).toString('hex'),
    );
  fs.writeFileSync('.env', text, { mode: 0o600 });
  console.log(
    '.env criado com segredos aleatórios. Consulte o arquivo para autorizar chamadas no Swagger.',
  );
}
