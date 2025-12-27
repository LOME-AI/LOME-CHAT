import { useQuery } from '@tanstack/react-query';
import type { DevPersonasResponse } from '@lome-chat/shared';

const API_URL = import.meta.env['VITE_API_URL'] as string;

export type PersonaType = 'dev' | 'test';

export const devPersonaKeys = {
  all: ['dev-personas'] as const,
  list: (type: PersonaType = 'dev') => [...devPersonaKeys.all, 'list', type] as const,
};

export function useDevPersonas(
  type: PersonaType = 'dev'
): ReturnType<typeof useQuery<DevPersonasResponse, Error>> {
  return useQuery({
    queryKey: devPersonaKeys.list(type),
    queryFn: async (): Promise<DevPersonasResponse> => {
      const response = await fetch(`${API_URL}/dev/personas?type=${type}`);
      if (!response.ok) {
        throw new Error('Failed to fetch dev personas');
      }
      return response.json() as Promise<DevPersonasResponse>;
    },
    enabled: import.meta.env.DEV,
  });
}
