import { ApolloServer } from '@apollo/server';
import { startServerAndCreateLambdaHandler, handlers } from '@as-integrations/aws-lambda';
import { GraphQLError } from 'graphql';
import { Pool } from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const secrets = new SecretsManagerClient({});
let pool: Pool | undefined;

// Create the DB connection once per Lambda container and reuse it
async function getPool(): Promise<Pool> {
  if (pool) return pool;

  const res = await secrets.send(
    new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN })
  );
  const { username, password } = JSON.parse(res.SecretString ?? '{}');

  const p = new Pool({
    host: process.env.DB_HOST,
    port: 5432,
    database: process.env.DB_NAME,
    user: username,
    password,
    ssl: { rejectUnauthorized: false },
    max: 2,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
  });

  await p.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      done BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  pool = p;
  return p;
}

const toTask = (row: any) => ({
  id: String(row.id),
  title: row.title,
  done: row.done,
  createdAt: row.created_at.toISOString(),
});

const typeDefs = `#graphql
  type Task {
    id: ID!
    title: String!
    done: Boolean!
    createdAt: String!
  }

  type Stats {
    total: Int!
    done: Int!
  }

  type Query {
    health: String!
    tasks: [Task!]!
    stats: Stats!
  }

  type Mutation {
    addTask(title: String!): Task!
  }
`;

const resolvers = {
  Query: {
    health: () => 'ok',
    tasks: async () => {
      const db = await getPool();
      const result = await db.query(
        'SELECT id, title, done, created_at FROM tasks ORDER BY id DESC LIMIT 50'
      );
      return result.rows.map(toTask);
    },
    stats: async () => {
      const res = await fetch(process.env.PRIVATE_GRAPHQL_URL as string, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ stats { total done } }' }),
        signal: AbortSignal.timeout(5000),
      });
      const json = (await res.json()) as any;
      if (json.errors) throw new GraphQLError('Private GraphQL server returned an error');
      return json.data.stats;
    },
  },
  Mutation: {
    addTask: async (_: unknown, args: { title: string }) => {
      const title = args.title.trim();
      if (!title || title.length > 200) {
        throw new GraphQLError('Title must be 1 to 200 characters');
      }
      const db = await getPool();
      const result = await db.query(
        'INSERT INTO tasks (title) VALUES ($1) RETURNING id, title, done, created_at',
        [title]
      );
      return toTask(result.rows[0]);
    },
  },
};

const server = new ApolloServer({ typeDefs, resolvers });

export const handler = startServerAndCreateLambdaHandler(
  server,
  handlers.createAPIGatewayProxyEventV2RequestHandler()
);