import { startTestServer } from "../__helpers__/server";

export default async function globalSetup() {
  const server = await startTestServer(3002);

  return async () => {
    await server.stop();
  };
}
