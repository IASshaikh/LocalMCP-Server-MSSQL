#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import sql from 'mssql';

// SQL Server configuration from environment variables
const config = {
  user: process.env.MSSQL_USER,
  password: process.env.MSSQL_PASSWORD,
  server: process.env.MSSQL_SERVER,
  database: process.env.MSSQL_DATABASE,
  port: parseInt(process.env.MSSQL_PORT || '1433'),
  options: {
    encrypt: true, // For Azure and secure connections
    trustServerCertificate: true, // Change to false in production with valid certificates
    enableArithAbort: true
  },
  connectionTimeout: 30000,
  requestTimeout: 30000
};

// Connection pool
let pool = null;

// Initialize connection pool
async function initializePool() {
  try {
    pool = await sql.connect(config);
    console.error('Successfully connected to MS SQL Server');
    return pool;
  } catch (err) {
    console.error('Database connection error:', err);
    throw err;
  }
}

// Execute query
async function executeQuery(query, params = {}) {
  try {
    if (!pool) {
      await initializePool();
    }
    
    const request = pool.request();
    
    // Add parameters if provided
    for (const [key, value] of Object.entries(params)) {
      request.input(key, value);
    }
    
    const result = await request.query(query);
    return result;
  } catch (err) {
    console.error('Query execution error:', err);
    throw err;
  }
}

// Get table schema
async function getTableSchema(tableName) {
  const query = `
    SELECT 
      c.COLUMN_NAME,
      c.DATA_TYPE,
      c.CHARACTER_MAXIMUM_LENGTH,
      c.IS_NULLABLE,
      c.COLUMN_DEFAULT
    FROM INFORMATION_SCHEMA.COLUMNS c
    WHERE c.TABLE_NAME = @tableName
    ORDER BY c.ORDINAL_POSITION
  `;
  
  return await executeQuery(query, { tableName });
}

// List all tables
async function listTables() {
  const query = `
    SELECT 
      TABLE_SCHEMA,
      TABLE_NAME,
      TABLE_TYPE
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_TYPE = 'BASE TABLE'
    ORDER BY TABLE_SCHEMA, TABLE_NAME
  `;
  
  return await executeQuery(query);
}

// Create MCP server
const server = new Server(
  {
    name: "mssql-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "query",
        description: "Execute a SQL query against the MS SQL Server database. Use parameterized queries for safety.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "SQL query to execute. Use @paramName for parameters.",
            },
            params: {
              type: "object",
              description: "Parameters for the query (optional). Key-value pairs where keys match @paramName in query.",
              additionalProperties: true,
            },
          },
          required: ["query"],
        },
      },
      {
        name: "list_tables",
        description: "List all tables in the database",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "describe_table",
        description: "Get the schema/structure of a specific table",
        inputSchema: {
          type: "object",
          properties: {
            table_name: {
              type: "string",
              description: "Name of the table to describe",
            },
          },
          required: ["table_name"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "query": {
        const result = await executeQuery(args.query, args.params || {});
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                rowCount: result.recordset.length,
                rows: result.recordset,
                rowsAffected: result.rowsAffected,
              }, null, 2),
            },
          ],
        };
      }

      case "list_tables": {
        const result = await listTables();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                tables: result.recordset,
              }, null, 2),
            },
          ],
        };
      }

      case "describe_table": {
        const result = await getTableSchema(args.table_name);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                table: args.table_name,
                columns: result.recordset,
              }, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  try {
    await initializePool();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("MS SQL Server MCP server running on stdio");
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

main();
