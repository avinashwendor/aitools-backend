/**
 * Stateless Streamable-HTTP MCP server mounted on the Express app.
 *
 * Auth: Bearer API key (`ait_…`) with `apiAccess` plan feature.
 * Each request creates a fresh McpServer + transport (stateless pattern).
 */

import { Router } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { authenticateApiKey } from '../middleware/apiKeyAuth.js';
import { withCurrentPeriod, planRateLimit } from '../middleware/entitlements.js';
import { ensureCurrentPeriod, canAfford, balanceOf, isUnmetered } from '../billing/credits.js';
import { creditCost, MIN_ACTION_COST } from '../billing/plans.js';
import * as tools from './tools.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('mcp');
const mcpLimiter = planRateLimit();

function createServerForUser(user) {
  const server = new McpServer({
    name: 'ai-tools',
    version: '1.0.0',
  });

  server.registerTool(
    'search_tools',
    {
      description: 'Search the AI Tools catalog by natural-language query.',
      inputSchema: {
        query: z.string().describe('What you need a tool for'),
        limit: z.number().optional().describe('Max results (default 8)'),
        pricing: z.enum(['free', 'freemium', 'paid', 'any']).optional(),
      },
    },
    async args => tools.searchTools({ user, ...args })
  );

  server.registerTool(
    'compare_tools',
    {
      description: 'Compare catalog tools by slug list and/or a query.',
      inputSchema: {
        slugs: z.array(z.string()).optional(),
        query: z.string().optional(),
      },
    },
    async args => tools.compareTools({ user, ...args })
  );

  server.registerTool(
    'plan_workflow',
    {
      description:
        'Plan a multi-stage AI-tool workflow for a goal. Metered — uses the same credits as the web chat.',
      inputSchema: {
        message: z.string().describe('The user goal or follow-up'),
        sessionId: z.string().optional().describe('Conversation session id (default mcp-default)'),
      },
    },
    async args => {
      if (!isUnmetered(user)) {
        const affordable = canAfford(user, MIN_ACTION_COST);
        if (!affordable) {
          return {
            content: [
              {
                type: 'text',
                text: `Insufficient credits (balance ${balanceOf(user)}). Need at least ${MIN_ACTION_COST}.`,
              },
            ],
            isError: true,
          };
        }
      }
      // Touch planWorkflow credit floor so admins see expected cost; real charge is inside tools.planWorkflow
      void creditCost('workflow.generate');
      return tools.planWorkflow({ user, ...args });
    }
  );

  server.registerTool(
    'get_playbook',
    {
      description: 'Get the playbook for a stage of the last planned workflow in a session.',
      inputSchema: {
        sessionId: z.string().optional(),
        stageId: z.string().optional().describe('Stage id or tool slug; defaults to first stage'),
      },
    },
    async args => tools.getPlaybook({ user, ...args })
  );

  server.registerTool(
    'create_task_board',
    {
      description: 'Commit the session workflow to a dated task board.',
      inputSchema: {
        sessionId: z.string().optional(),
        weeklyHours: z.number().optional(),
        targetDate: z.string().optional().describe('ISO date deadline'),
      },
    },
    async args => tools.createTaskBoard({ user, ...args })
  );

  server.registerTool(
    'get_board_status',
    {
      description: 'Get progress summary for a task board by id.',
      inputSchema: {
        boardId: z.string().describe('Mongo id of the task board'),
      },
    },
    async args => tools.getBoardStatus({ user, ...args })
  );

  return server;
}

async function handleMcpPost(req, res) {
  const server = createServerForUser(req.user);
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => {
      transport.close();
      server.close();
    });
  } catch (err) {
    log.error('MCP request failed', { error: err.message });
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
}

/**
 * Mount on the main Express app at `/mcp` (outside `/api` so MCP clients use a
 * short URL). Also available under `/api/mcp` for consistency.
 */
export function createMcpRouter() {
  const router = Router();
  router.use(authenticateApiKey);
  router.use(withCurrentPeriod);
  router.use(async (req, _res, next) => {
    try {
      req.user = await ensureCurrentPeriod(req.user);
    } catch {
      /* keep stale period */
    }
    next();
  });
  router.use(mcpLimiter);

  router.post('/', handleMcpPost);
  router.get('/', (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. Use POST.' },
      id: null,
    });
  });
  router.delete('/', (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    });
  });

  return router;
}

export default createMcpRouter;
