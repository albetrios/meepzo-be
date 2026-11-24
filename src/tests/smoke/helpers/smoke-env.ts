export type SmokeEnvironment = {
  baseUrl: string;
  demoEmail: string;
};

export function loadSmokeEnvironment(): SmokeEnvironment {
  const baseUrl =
    process.env.SMOKE_BASE_URL?.trim() || process.env.BASE_URL?.trim() || 'http://localhost:3000';
  const demoEmail = process.env.SMOKE_DEMO_EMAIL ?? process.env.DEMO_EMAIL ?? 'demo@example.com';
  return { baseUrl, demoEmail };
}
