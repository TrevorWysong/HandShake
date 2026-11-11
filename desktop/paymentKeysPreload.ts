// The key window's preload (desktop/paymentKeys.ts): asks the main process
// for the form, draws it into the page's empty markup (desktop/
// paymentKeys.html) with text only -- never markup -- and sends back the
// keys, or that the person closed it. Nothing is exposed to the page, which
// runs no script of its own.
import { ipcRenderer } from 'electron';
import { KEY_CHANNEL, type KeyAnswer, type KeyField, type KeyForm } from '../main/handshake/paymentKeyForm';

const answer = (given: KeyAnswer) => ipcRenderer.invoke(KEY_CHANNEL, 'answer', given);

window.addEventListener('DOMContentLoaded', async () => {
  const form: KeyForm = await ipcRenderer.invoke(KEY_CHANNEL, 'form');
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const keys = element<HTMLFormElement>('keys');
  const connect = element<HTMLButtonElement>('connect');
  const cancel = element<HTMLButtonElement>('cancel');

  document.documentElement.lang = form.locale;
  document.title = form.title;
  element('title').textContent = form.title;
  element('intro').textContent = form.intro;
  element('stays').textContent = form.stays;
  connect.textContent = form.connect;
  cancel.textContent = form.cancel;

  const inputs = form.fields.map((field) => {
    const { row, input } = fieldRow(field, form);
    element('fields').append(row);
    return input;
  });
  const values = () => Object.fromEntries(inputs.map((input) => [input.name, input.value.trim()]));
  const complete = () => inputs.every((input) => input.value.trim() !== '');
  keys.addEventListener('input', () => (connect.disabled = !complete()));
  void ipcRenderer.invoke(KEY_CHANNEL, 'fit', document.querySelector('main')?.getBoundingClientRect().height);
  inputs[0]?.focus();

  keys.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!complete() || keys.dataset.busy) return;
    keys.dataset.busy = 'true';
    for (const control of keys.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')) control.disabled = true;
    connect.textContent = form.checking;
    void answer({ keys: values() });
  });
  cancel.addEventListener('click', () => void answer({ cancel: true }));
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !keys.dataset.busy) void answer({ cancel: true });
  });
});

/// One key's label and box -- hidden as it's typed, if it's a secret, with
/// a button to show it.
function fieldRow(field: KeyField, form: KeyForm): { row: HTMLElement; input: HTMLInputElement } {
  const id = `key-${field.name}`;
  const row = document.createElement('div');
  row.className = 'field';
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = field.label;
  const entry = document.createElement('div');
  entry.className = 'entry';
  const input = document.createElement('input');
  Object.assign(input, { id, name: field.name, type: field.secret ? 'password' : 'text', placeholder: field.placeholder, autocomplete: 'off', spellcheck: false });
  input.setAttribute('autocapitalize', 'off');
  entry.append(input);
  if (field.secret) {
    const reveal = document.createElement('button');
    reveal.type = 'button';
    reveal.className = 'reveal';
    reveal.textContent = form.show;
    reveal.setAttribute('aria-controls', id);
    reveal.addEventListener('click', () => {
      const hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      reveal.textContent = hidden ? form.hide : form.show;
    });
    entry.append(reveal);
  }
  row.append(label, entry);
  return { row, input };
}
