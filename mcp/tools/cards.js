import { z } from 'zod';
import { toolHandler } from '../client.js';

// A card is addressed by EITHER its numeric row id or its string clientKey --
// list_cards reports whichever it has, and every card the UI creates carries a
// UUID key. The schemas below take both; the server resolves either through
// resolveProjectCard. Declaring them int-only rejected every UI-made card.
// Kanban columns are fixed (seeded in storage.js). Accept names, map to ids.
const KANBAN_COLUMNS = {
  'images': 1,
  'image edit': 2,
  'mesh gen': 3,
  'mesh edit': 4,
  'texturing': 5,
  'rigging': 6
};

function resolveColumnId(column) {
  if (typeof column === 'number') return column;
  const id = KANBAN_COLUMNS[String(column || '').trim().toLowerCase()];
  if (!id) {
    throw new Error(`Unknown kanban column "${column}". Valid columns: Images, Image Edit, Mesh Gen, Mesh Edit, Texturing, Rigging.`);
  }
  return id;
}

export function registerCardTools(server, { api, notifyMutation }) {
  server.registerTool('list_cards', {
    title: 'List cards',
    description: 'List every card of a project. Kanban cards carry kanbanColumnId (1=Images, 2=Image Edit, 3=Mesh Gen, 4=Mesh Edit, 5=Texturing, 6=Rigging) and position; graph nodes appear here too with a non-null nodeTypeId (use get_graph for the graph view).',
    inputSchema: { projectId: z.number().int() },
    annotations: { readOnlyHint: true }
  }, toolHandler(async ({ projectId }) => api.apiJson('GET', '/cards', { query: { projectId } })));

  server.registerTool('create_card', {
    title: 'Create kanban card',
    description: 'Create an EMPTY kanban card in a project, ready to be filled later. Not needed before generating: generate_image / run_workflow / generate_mesh / upload_asset already create their own card when no cardId is passed. Use this to lay a board out first, or to make a card whose id you choose (pass cardId) and then point several generations at it. Returns the card; its `id` is what move_card, delete_card, create_card_attribute and the generation tools take as cardId.',
    inputSchema: {
      projectId: z.number().int(),
      column: z.string().default('Images').describe('Column name: Images, Image Edit, Mesh Gen, Mesh Edit, Texturing, Rigging'),
      name: z.string().optional().describe('Card title'),
      cardId: z.string().optional().describe('Your own id for the card (any string). Pass the same value to a generation tool to make its result land on this card. Omit to get a generated numeric id.'),
      position: z.number().int().min(0).optional().describe('0-based position in the column (default: appended at the end)')
    }
  }, toolHandler(async ({ projectId, column, name, cardId, position }) => {
    // The column is validated here as well as server-side so a wrong name comes
    // back as the list of valid ones rather than a 400 the model has to guess at.
    resolveColumnId(column);
    const card = await api.apiJson('POST', '/cards', {
      body: {
        projectId,
        column,
        ...(name !== undefined ? { name } : {}),
        ...(cardId !== undefined ? { cardId } : {}),
        ...(position !== undefined ? { position } : {})
      }
    });
    notifyMutation(projectId);
    return card;
  }));

  server.registerTool('move_card', {
    title: 'Move kanban card',
    description: 'Move a kanban card to a column ("Images", "Image Edit", "Mesh Gen", "Mesh Edit", "Texturing", "Rigging") at the given position (0-based).',
    inputSchema: {
      projectId: z.number().int(),
      cardId: z.union([z.number().int(), z.string()]).describe('Card id (the `id` from list_cards or create_card; a number or a string key)'),
      column: z.string().describe('Target column name'),
      position: z.number().int().min(0).describe('0-based position inside the column')
    }
  }, toolHandler(async ({ projectId, cardId, column, position }) => {
    const result = await api.apiJson('PUT', '/cards/move', {
      body: { projectId, cardId, kanbanColumnId: resolveColumnId(column), position }
    });
    notifyMutation(projectId);
    return result;
  }));

  server.registerTool('delete_card', {
    title: 'Delete card',
    description: 'PERMANENTLY delete a card from a project (its linked assets remain).',
    inputSchema: { projectId: z.number().int(), cardId: z.union([z.number().int(), z.string()]) },
    annotations: { destructiveHint: true }
  }, toolHandler(async ({ projectId, cardId }) => {
    await api.apiJson('DELETE', `/cards/${encodeURIComponent(cardId)}`, { query: { projectId } });
    notifyMutation(projectId);
    return { deleted: true, cardId };
  }));

  server.registerTool('list_card_attributes', {
    title: 'List card attributes',
    description: 'List custom attributes attached to a project\'s cards, plus the available attribute types (1=Text, 2=Number).',
    inputSchema: { projectId: z.number().int() },
    annotations: { readOnlyHint: true }
  }, toolHandler(async ({ projectId }) => {
    const [attributes, types] = await Promise.all([
      api.apiJson('GET', '/card-attributes', { query: { projectId } }),
      api.apiJson('GET', '/card-attributes/types')
    ]);
    return { attributes, types };
  }));

  server.registerTool('create_card_attribute', {
    title: 'Create card attribute',
    description: 'Add a custom attribute to a card. attributeTypeId: 1=Text, 2=Number.',
    inputSchema: {
      projectId: z.number().int(),
      cardId: z.union([z.number().int(), z.string()]),
      attributeTypeId: z.number().int().describe('1=Text, 2=Number'),
      value: z.string().default('').describe('Attribute value (string; numbers as text)')
    }
  }, toolHandler(async ({ projectId, cardId, attributeTypeId, value }) => {
    const attribute = await api.apiJson('POST', '/card-attributes', {
      body: { projectId, cardId, attributeTypeId, attributeValue: value }
    });
    notifyMutation(projectId);
    return attribute;
  }));

  server.registerTool('update_card_attribute', {
    title: 'Update card attribute',
    description: 'Update a card attribute (identified by cardId + position from list_card_attributes).',
    inputSchema: {
      projectId: z.number().int(),
      cardId: z.union([z.number().int(), z.string()]),
      position: z.number().int(),
      attributeTypeId: z.number().int().optional(),
      value: z.string().optional()
    }
  }, toolHandler(async ({ projectId, cardId, position, attributeTypeId, value }) => {
    const attribute = await api.apiJson('PUT', `/card-attributes/${encodeURIComponent(cardId)}/${position}`, {
      body: {
        projectId,
        ...(attributeTypeId !== undefined ? { attributeTypeId } : {}),
        ...(value !== undefined ? { attributeValue: value } : {})
      }
    });
    notifyMutation(projectId);
    return attribute;
  }));

  server.registerTool('delete_card_attribute', {
    title: 'Delete card attribute',
    description: 'Delete a card attribute (identified by cardId + position).',
    inputSchema: {
      projectId: z.number().int(),
      cardId: z.union([z.number().int(), z.string()]),
      position: z.number().int()
    },
    annotations: { destructiveHint: true }
  }, toolHandler(async ({ projectId, cardId, position }) => {
    await api.apiJson('DELETE', `/card-attributes/${encodeURIComponent(cardId)}/${position}`, { query: { projectId } });
    notifyMutation(projectId);
    return { deleted: true, cardId, position };
  }));
}
