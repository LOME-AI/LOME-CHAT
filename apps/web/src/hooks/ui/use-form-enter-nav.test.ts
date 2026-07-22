// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useFormEnterNav } from '@/hooks/ui/use-form-enter-nav';

function createInput(type = 'text'): HTMLInputElement {
  const input = document.createElement('input');
  input.type = type;
  return input;
}

function createTextarea(): HTMLTextAreaElement {
  return document.createElement('textarea');
}

function createSelect(): HTMLSelectElement {
  return document.createElement('select');
}

function fireEnter(
  target: HTMLElement,
  modifiers: Partial<Record<'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey', boolean>> = {}
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  target.dispatchEvent(event);
  return event;
}

describe('useFormEnterNav', () => {
  let form: HTMLFormElement;

  beforeEach(() => {
    form = document.createElement('form');
    document.body.append(form);
  });

  afterEach(() => {
    form.remove();
  });

  it('does not throw when ref is null', () => {
    const ref = { current: null };
    expect(() => {
      renderHook(() => {
        useFormEnterNav(ref);
      });
    }).not.toThrow();
  });

  it('focuses next input on Enter when not the last input', () => {
    const input1 = createInput();
    const input2 = createInput();
    form.append(input1, input2);

    const ref = { current: form };
    renderHook(() => {
      useFormEnterNav(ref);
    });

    input1.focus();
    fireEnter(input1);
    expect(document.activeElement).toBe(input2);
  });

  it('calls requestSubmit on Enter when on the last input', () => {
    const input1 = createInput();
    const input2 = createInput();
    form.append(input1, input2);
    const requestSubmit = vi.fn();
    form.requestSubmit = requestSubmit;

    const ref = { current: form };
    renderHook(() => {
      useFormEnterNav(ref);
    });

    input2.focus();
    fireEnter(input2);
    expect(requestSubmit).toHaveBeenCalledOnce();
  });

  it('calls requestSubmit when there is only one input', () => {
    const input = createInput();
    form.append(input);
    const requestSubmit = vi.fn();
    form.requestSubmit = requestSubmit;

    const ref = { current: form };
    renderHook(() => {
      useFormEnterNav(ref);
    });

    input.focus();
    fireEnter(input);
    expect(requestSubmit).toHaveBeenCalledOnce();
  });

  it('prevents default on Enter', () => {
    const input1 = createInput();
    const input2 = createInput();
    form.append(input1, input2);

    const ref = { current: form };
    renderHook(() => {
      useFormEnterNav(ref);
    });

    input1.focus();
    const event = fireEnter(input1);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each([
    { modifier: 'shiftKey' as const, label: 'Shift' },
    { modifier: 'ctrlKey' as const, label: 'Ctrl' },
    { modifier: 'metaKey' as const, label: 'Meta' },
    { modifier: 'altKey' as const, label: 'Alt' },
  ])('ignores $label+Enter', ({ modifier }) => {
    const input1 = createInput();
    const input2 = createInput();
    form.append(input1, input2);

    const ref = { current: form };
    renderHook(() => {
      useFormEnterNav(ref);
    });

    input1.focus();
    const event = fireEnter(input1, { [modifier]: true });
    expect(document.activeElement).toBe(input1);
    expect(event.defaultPrevented).toBe(false);
  });

  it('ignores Enter on textarea', () => {
    const textarea = createTextarea();
    const input = createInput();
    form.append(textarea, input);

    const ref = { current: form };
    renderHook(() => {
      useFormEnterNav(ref);
    });

    textarea.focus();
    const event = fireEnter(textarea);
    expect(document.activeElement).toBe(textarea);
    expect(event.defaultPrevented).toBe(false);
  });

  it('ignores Enter on select', () => {
    const select = createSelect();
    const input = createInput();
    form.append(select, input);

    const ref = { current: form };
    renderHook(() => {
      useFormEnterNav(ref);
    });

    select.focus();
    const event = fireEnter(select);
    expect(document.activeElement).toBe(select);
    expect(event.defaultPrevented).toBe(false);
  });

  it('ignores Enter on button', () => {
    const button = document.createElement('button');
    const input = createInput();
    form.append(button, input);

    const ref = { current: form };
    renderHook(() => {
      useFormEnterNav(ref);
    });

    button.focus();
    const event = fireEnter(button);
    expect(document.activeElement).toBe(button);
    expect(event.defaultPrevented).toBe(false);
  });

  it('skips disabled inputs in navigation', () => {
    const input1 = createInput();
    const input2 = createInput();
    input2.disabled = true;
    const input3 = createInput();
    form.append(input1, input2, input3);

    const ref = { current: form };
    renderHook(() => {
      useFormEnterNav(ref);
    });

    input1.focus();
    fireEnter(input1);
    expect(document.activeElement).toBe(input3);
  });

  it('skips hidden inputs', () => {
    const input1 = createInput();
    const hidden = createInput('hidden');
    const input2 = createInput();
    form.append(input1, hidden, input2);

    const ref = { current: form };
    renderHook(() => {
      useFormEnterNav(ref);
    });

    input1.focus();
    fireEnter(input1);
    expect(document.activeElement).toBe(input2);
  });

  it('skips checkbox inputs', () => {
    const input1 = createInput();
    const checkbox = createInput('checkbox');
    const input2 = createInput();
    form.append(input1, checkbox, input2);

    const ref = { current: form };
    renderHook(() => {
      useFormEnterNav(ref);
    });

    input1.focus();
    fireEnter(input1);
    expect(document.activeElement).toBe(input2);
  });

  it('skips radio inputs', () => {
    const input1 = createInput();
    const radio = createInput('radio');
    const input2 = createInput();
    form.append(input1, radio, input2);

    const ref = { current: form };
    renderHook(() => {
      useFormEnterNav(ref);
    });

    input1.focus();
    fireEnter(input1);
    expect(document.activeElement).toBe(input2);
  });

  it('navigates through mixed text-like input types', () => {
    const text = createInput('text');
    const password = createInput('password');
    const email = createInput('email');
    const number = createInput('number');
    form.append(text, password, email, number);
    const requestSubmit = vi.fn();
    form.requestSubmit = requestSubmit;

    const ref = { current: form };
    renderHook(() => {
      useFormEnterNav(ref);
    });

    text.focus();
    fireEnter(text);
    expect(document.activeElement).toBe(password);

    fireEnter(password);
    expect(document.activeElement).toBe(email);

    fireEnter(email);
    expect(document.activeElement).toBe(number);

    fireEnter(number);
    expect(requestSubmit).toHaveBeenCalledOnce();
  });

  it('removes listener on unmount', () => {
    const input1 = createInput();
    const input2 = createInput();
    form.append(input1, input2);

    const ref = { current: form };
    const { unmount } = renderHook(() => {
      useFormEnterNav(ref);
    });

    unmount();

    input1.focus();
    fireEnter(input1);
    expect(document.activeElement).toBe(input1);
  });

  it('handles dynamically added inputs', () => {
    const input1 = createInput();
    form.append(input1);
    const requestSubmit = vi.fn();
    form.requestSubmit = requestSubmit;

    const ref = { current: form };
    renderHook(() => {
      useFormEnterNav(ref);
    });

    // Initially only one input — Enter submits
    input1.focus();
    fireEnter(input1);
    expect(requestSubmit).toHaveBeenCalledOnce();
    requestSubmit.mockClear();

    // Add a second input — Enter now navigates
    const input2 = createInput();
    form.append(input2);

    input1.focus();
    fireEnter(input1);
    expect(document.activeElement).toBe(input2);
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it('clicks an inside submit button on Enter from the last input', () => {
    const input = createInput();
    const submit = document.createElement('button');
    submit.type = 'submit';
    const onClick = vi.fn();
    submit.addEventListener('click', onClick);
    form.append(input, submit);
    const requestSubmit = vi.fn();
    form.requestSubmit = requestSubmit;

    const ref = { current: form };
    renderHook(() => {
      useFormEnterNav(ref);
    });

    input.focus();
    fireEnter(input);

    expect(onClick).toHaveBeenCalledOnce();
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it('clicks an external submit button linked via form="id"', () => {
    form.id = 'my-form';
    const input = createInput();
    form.append(input);

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.setAttribute('form', 'my-form');
    const onClick = vi.fn();
    submit.addEventListener('click', onClick);
    document.body.append(submit);

    const requestSubmit = vi.fn();
    form.requestSubmit = requestSubmit;

    const ref = { current: form };
    renderHook(() => {
      useFormEnterNav(ref);
    });

    input.focus();
    fireEnter(input);

    expect(onClick).toHaveBeenCalledOnce();
    expect(requestSubmit).not.toHaveBeenCalled();

    submit.remove();
  });

  it('skips disabled submit buttons and falls back to requestSubmit', () => {
    const input = createInput();
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.disabled = true;
    form.append(input, submit);
    const requestSubmit = vi.fn();
    form.requestSubmit = requestSubmit;

    const ref = { current: form };
    renderHook(() => {
      useFormEnterNav(ref);
    });

    input.focus();
    fireEnter(input);

    expect(requestSubmit).toHaveBeenCalledOnce();
  });

  it('skips aria-disabled submit buttons inside the form', () => {
    const input = createInput();
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.setAttribute('aria-disabled', 'true');
    const onClick = vi.fn();
    submit.addEventListener('click', onClick);
    form.append(input, submit);
    const requestSubmit = vi.fn();
    form.requestSubmit = requestSubmit;

    const ref = { current: form };
    renderHook(() => {
      useFormEnterNav(ref);
    });

    input.focus();
    fireEnter(input);

    expect(onClick).not.toHaveBeenCalled();
    expect(requestSubmit).toHaveBeenCalledOnce();
  });

  it('ignores Enter from an input outside the form (index -1)', () => {
    const inside = createInput();
    form.append(inside);
    const outside = createInput();
    document.body.append(outside);
    const requestSubmit = vi.fn();
    form.requestSubmit = requestSubmit;

    const ref = { current: form };
    renderHook(() => {
      useFormEnterNav(ref);
    });

    outside.focus();
    const event = fireEnter(outside);

    expect(event.defaultPrevented).toBe(false);
    expect(requestSubmit).not.toHaveBeenCalled();

    outside.remove();
  });

  it('ignores unrelated external submit buttons and falls back to requestSubmit', () => {
    const input = createInput();
    form.append(input);

    // A submit button belonging to a *different* form must not be picked up.
    const otherForm = document.createElement('form');
    const otherSubmit = document.createElement('button');
    otherSubmit.type = 'submit';
    const otherOnClick = vi.fn();
    otherSubmit.addEventListener('click', otherOnClick);
    otherForm.append(otherSubmit);
    document.body.append(otherForm);

    const requestSubmit = vi.fn();
    form.requestSubmit = requestSubmit;

    const ref = { current: form };
    renderHook(() => {
      useFormEnterNav(ref);
    });

    input.focus();
    fireEnter(input);

    expect(otherOnClick).not.toHaveBeenCalled();
    expect(requestSubmit).toHaveBeenCalledOnce();

    otherForm.remove();
  });

  it('handles form ids containing CSS-special characters', () => {
    form.id = 'my.form:1';
    const input = createInput();
    form.append(input);

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.setAttribute('form', 'my.form:1');
    const onClick = vi.fn();
    submit.addEventListener('click', onClick);
    document.body.append(submit);

    const ref = { current: form };
    renderHook(() => {
      useFormEnterNav(ref);
    });

    input.focus();
    fireEnter(input);

    expect(onClick).toHaveBeenCalledOnce();

    submit.remove();
  });
});
