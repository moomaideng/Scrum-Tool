import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

export function readConfig(env = process.env) {
  const port = Number(env.PORT ?? 3000);
  const appOrigin = String(env.STANDUP_APP_ORIGIN || `http://localhost:${port}`).replace(/\/$/, '');
  return {
    port,
    basePath: '/standup',
    appOrigin,
    publicDirectory: path.join(moduleDirectory, '..', 'public'),
    dataDirectory: env.DATA_DIR ?? path.join(moduleDirectory, '..', 'data'),
    googleClientId: env.GOOGLE_CLIENT_ID ?? '',
    googleServiceAccountBase64: env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 ?? '',
    googleServiceAccountFile: env.GOOGLE_SERVICE_ACCOUNT_FILE ?? '',
    googleSpreadsheetId: env.GOOGLE_SPREADSHEET_ID ?? '',
    smtp: {
      host: env.SMTP_HOST ?? '',
      port: Number(env.SMTP_PORT ?? 465),
      secure: String(env.SMTP_SECURE ?? 'true').toLocaleLowerCase() !== 'false',
      user: env.SMTP_USER ?? '',
      password: env.SMTP_PASSWORD ?? '',
      from: env.SMTP_FROM ?? env.SMTP_USER ?? '',
    },
  };
}
