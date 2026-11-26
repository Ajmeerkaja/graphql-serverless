import express from 'express';
import cors from 'cors';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import pg from 'pg';

// DB settings arrive as environment variables. The password is injected by ECS
// from AWS Secrets Manager, so it never appears in code or in the image.
const pool = new pg.Pool({
  host: process.env.DB_HOST,
  port: 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
  max: 5,
  connectionTimeoutMillis: 5000,
});

const typeDefs = `#graphql
  type Stats {
    total: Int!
    done: Int!
  }

  type Query {
    health: String!
    stats: Stats!
  }
`;

const resolvers = {
  Query: {
    health: () => 'ok',
    stats: async () => {
      const r = await pool.query(
        'SELECT count(*)::int AS total, count(*) FILTER (WHERE done)::int AS done FROM tasks'
      );
      return r.rows[0];
    },
  },
};

const server = new ApolloServer({ typeDefs, resolvers });
await server.start();

const app = express();

// Plain health endpoint for the load balancer (does not touch the database)
app.get('/health', (_req, res) => res.status(200).send('ok'));

app.use('/graphql', cors(), express.json(), expressMiddleware(server));

app.listen(4000, '0.0.0.0', () => {
  console.log('GraphQL server ready on port 4000 at /graphql');
});