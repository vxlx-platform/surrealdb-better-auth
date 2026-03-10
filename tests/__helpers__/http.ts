export async function expectOkJson(response: Response, context: string) {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${context} failed with ${response.status} ${response.statusText}: ${body}`);
  }

  return response.json();
}
