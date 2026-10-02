import { z } from 'zod';
import { toolResult } from './common.mjs';

export function registerQueryDb(server, deps) {
  server.registerTool(
    'query_db',
    {
      title: 'Consulta SQL read-only',
      description: 'Consulta ad-hoc SELECT/WITH contra la BD de OpenCode, en modo read-only y con LIMIT forzado.',
      inputSchema: {
        sql: z.string(),
        raw: z.boolean().optional().default(false),
      },
    },
    async ({ sql, raw }) => {
      if (!deps.db?.available()) {
        return { content: [{ type: 'text', text: 'No hay BD de OpenCode disponible.' }], isError: true };
      }
      try {
        const rows = deps.db.query(sql);
        const preview = rows.slice(0, 20);
        const truncated = rows.length > preview.length;
        const header = truncated
          ? `Filas: ${rows.length} (mostrando ${preview.length}; usá raw:true para ver todas)`
          : `Filas: ${rows.length}`;
        const text = `${header}\n${preview.map((r) => JSON.stringify(r)).join('\n')}`;
        return toolResult({ text, structured: { rows: preview, truncated, raw: raw ? rows : undefined } });
      } catch (err) {
        return { content: [{ type: 'text', text: `Consulta rechazada: ${err.message}` }], isError: true };
      }
    },
  );
}
