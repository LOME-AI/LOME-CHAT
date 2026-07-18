import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { requestUrl } from '@/test-utils/request-url';
import { PreviewPane } from './preview-pane.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const HTML = '<h1>July product notes</h1><p>dispatch-path output</p>';

function stubRender(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(Response.json({ html: HTML }))
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('PreviewPane', () => {
  it('renders the endpoint html verbatim into a sandboxed iframe', async () => {
    stubRender();
    render(<PreviewPane subject="July product notes" bodyMarkdown="# hi" />);

    const iframe = await screen.findByTestId(TEST_IDS.adminNewsletterPreview);
    expect(iframe).toHaveAttribute('srcdoc', HTML);
    expect(iframe).toHaveAttribute('sandbox', '');
  });

  it('debounces typing into one render request carrying the final draft', async () => {
    const fetchMock = stubRender();
    const { rerender } = render(<PreviewPane subject="Ju" bodyMarkdown="# h" />);
    rerender(<PreviewPane subject="Jul" bodyMarkdown="# hi" />);
    rerender(<PreviewPane subject="July" bodyMarkdown="# hi!" />);

    await screen.findByTestId(TEST_IDS.adminNewsletterPreview);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestUrl(fetchMock.mock.calls[0]![0])).toContain('/api/admin/newsletter/render');
    expect(JSON.parse(fetchMock.mock.calls[0]![1]?.body as string)).toEqual({
      subject: 'July',
      bodyMarkdown: '# hi!',
    });
  });

  it('shows the empty placeholder and fires no request while the draft is incomplete', () => {
    const fetchMock = stubRender();
    render(<PreviewPane subject="July" bodyMarkdown="" />);
    expect(screen.getByText(/preview appears/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows an error state when the render endpoint fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ code: 'VALIDATION' }, { status: 400 })))
    );
    render(<PreviewPane subject="July" bodyMarkdown="# hi" />);
    expect(await screen.findByText('Failed to render the preview.')).toBeInTheDocument();
  });

  it('discards a superseded render result instead of clobbering the newer preview', async () => {
    const deferred: ((response: Response) => void)[] = [];
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          deferred.push(resolve);
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(<PreviewPane subject="A" bodyMarkdown="one" />);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    rerender(<PreviewPane subject="B" bodyMarkdown="two" />);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    deferred[0]!(Response.json({ html: '<p>stale</p>' }));
    deferred[1]!(Response.json({ html: '<p>fresh</p>' }));

    const iframe = await screen.findByTestId(TEST_IDS.adminNewsletterPreview);
    await waitFor(() => {
      expect(iframe).toHaveAttribute('srcdoc', '<p>fresh</p>');
    });
  });

  it('ignores a superseded render failure instead of flashing an error', async () => {
    const deferred: { resolve: (response: Response) => void; reject: (cause: Error) => void }[] =
      [];
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve, reject) => {
          deferred.push({ resolve, reject });
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(<PreviewPane subject="A" bodyMarkdown="one" />);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    rerender(<PreviewPane subject="B" bodyMarkdown="two" />);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    deferred[0]!.reject(new Error('network down'));
    deferred[1]!.resolve(Response.json({ html: '<p>fresh</p>' }));

    const iframe = await screen.findByTestId(TEST_IDS.adminNewsletterPreview);
    expect(iframe).toHaveAttribute('srcdoc', '<p>fresh</p>');
    expect(screen.queryByText('Failed to render the preview.')).not.toBeInTheDocument();
  });

  it('clears a stale preview back to the placeholder when the draft empties', async () => {
    stubRender();
    const { rerender } = render(<PreviewPane subject="July" bodyMarkdown="# hi" />);
    await screen.findByTestId(TEST_IDS.adminNewsletterPreview);

    rerender(<PreviewPane subject="July" bodyMarkdown="" />);
    expect(screen.queryByTestId(TEST_IDS.adminNewsletterPreview)).not.toBeInTheDocument();
    expect(screen.getByText(/preview appears/i)).toBeInTheDocument();
  });
});
