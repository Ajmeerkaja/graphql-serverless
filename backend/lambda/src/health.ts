import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

export const handler = async (): Promise<APIGatewayProxyStructuredResultV2> => {
  try {
    const res = await fetch(process.env.PRIVATE_GRAPHQL_URL as string, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ stats { total } }' }),
      signal: AbortSignal.timeout(5000),
    });
    const json = (await res.json()) as any;
    if (!res.ok || json.errors) throw new Error('private server unhealthy');

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'ok', tasks: json.data.stats.total }),
    };
  } catch (err) {
    console.error('Health check failed', err);
    return {
      statusCode: 503,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'unhealthy' }),
    };
  }
};