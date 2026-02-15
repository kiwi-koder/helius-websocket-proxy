export interface EnvConfig {
  HELIUS_API_KEY: string;
  HELIUS_WS_URL: string;
  PORT: number;
  IDLE_TIMEOUT_MS: number;
  ALLOWED_ORIGINS: string;
}

export default (): EnvConfig => ({
  HELIUS_API_KEY: process.env.HELIUS_API_KEY ?? '',
  HELIUS_WS_URL: process.env.HELIUS_WS_URL ?? 'wss://mainnet.helius-rpc.com',
  PORT: parseInt(process.env.PORT ?? '3000', 10),
  IDLE_TIMEOUT_MS: parseInt(process.env.IDLE_TIMEOUT_MS ?? '300000', 10),
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000',
});
