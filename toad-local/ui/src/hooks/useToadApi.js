import { useState, useCallback } from 'react';
import { TOAD_API_CALL_URL, toadApiHeaders } from '../config/toadApi';

export function useToadApi() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const callTool = useCallback(async (method, args = {}, actor = { teamId: 'local', agentId: 'operator' }) => {
    setLoading(true);
    setError(null);
    try {
      const { idempotencyKey, ...toolArgs } = args || {};
      const response = await fetch(TOAD_API_CALL_URL, {
        method: 'POST',
        headers: toadApiHeaders(),
        body: JSON.stringify({ actor, method, args: toolArgs, idempotencyKey }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'API Request Failed');
      }

      return data.result;
    } catch (err) {
      console.error(`Error calling ${method}:`, err);
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return { callTool, loading, error };
}
