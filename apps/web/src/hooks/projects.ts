import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NewProject, Project } from '@lome-chat/db';

// Query key factory
export const projectKeys = {
  all: ['projects'] as const,
  list: () => [...projectKeys.all, 'list'] as const,
  detail: (id: string) => [...projectKeys.all, id] as const,
};

// Queries (disabled until API exists in Phase 11)
export function useProjects(): ReturnType<typeof useQuery<Project[], Error>> {
  return useQuery({
    queryKey: projectKeys.list(),
    queryFn: (): Promise<Project[]> =>
      Promise.reject(new Error('API not implemented - enable in Phase 11')),
    enabled: false,
  });
}

export function useProject(id: string): ReturnType<typeof useQuery<Project, Error>> {
  return useQuery({
    queryKey: projectKeys.detail(id),
    queryFn: (): Promise<Project> =>
      Promise.reject(new Error('API not implemented - enable in Phase 11')),
    enabled: false,
  });
}

// Mutations (stubs)
export function useCreateProject(): ReturnType<typeof useMutation<Project, Error, NewProject>> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (): Promise<Project> =>
      Promise.reject(new Error('API not implemented - enable in Phase 11')),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.list() });
    },
  });
}
