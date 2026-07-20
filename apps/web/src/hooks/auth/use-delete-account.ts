import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import { client, fetchJson } from '@/lib/api-client';

interface DeleteAccountInitRequest {
  ke1: number[];
}

interface DeleteAccountInitResponse {
  ke2: number[];
  deleteAccountSessionId: string;
}

interface DeleteAccountFinishRequest {
  ke3: number[];
  totpCode?: string;
  confirmationPhrase: string;
  deleteAccountSessionId: string;
}

export function useDeleteAccountInit(): UseMutationResult<
  DeleteAccountInitResponse,
  Error,
  DeleteAccountInitRequest
> {
  return useMutation({
    mutationFn: async (body: DeleteAccountInitRequest): Promise<DeleteAccountInitResponse> => {
      return fetchJson(client.auth.account.delete.init.$post({ json: body }));
    },
  });
}

export function useDeleteAccountFinish(): UseMutationResult<
  void,
  Error,
  DeleteAccountFinishRequest
> {
  return useMutation({
    mutationFn: async (body: DeleteAccountFinishRequest): Promise<void> => {
      const json: DeleteAccountFinishRequest = {
        ke3: body.ke3,
        confirmationPhrase: body.confirmationPhrase,
        deleteAccountSessionId: body.deleteAccountSessionId,
      };
      if (body.totpCode !== undefined) {
        json.totpCode = body.totpCode;
      }
      await fetchJson<unknown>(client.auth.account.delete.finish.$post({ json }));
    },
  });
}
