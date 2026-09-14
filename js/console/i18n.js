// Console localization. The legacy workspace uses short key ids through
// js/i18n.js. The Cloud console has hundreds of complete sentences; it uses the
// same language state but a gettext-style message catalog: English source text
// is the message id, and the zh catalog supplies translations.
// test/console-i18n.test.js enforces that every ct() message in js/console has
// a Chinese translation with matching interpolation placeholders.
import { getLanguage, CONSOLE_LOCALES } from '../i18n.js';

export function ct(message, params = null) {
  const lang = getLanguage();
  const catalog = CONSOLE_LOCALES[lang];
  let out = (catalog && Object.prototype.hasOwnProperty.call(catalog, message))
    ? catalog[message]
    : message;
  if (params) {
    out = out.replace(/\{(\w+)\}/g, (match, name) => (
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
    ));
  }
  return out;
}

// Attribute-bound helper for dynamic aria/title/label strings.
export function ctAttr(element, attribute, message, params = null) {
  element.setAttribute(attribute, ct(message, params));
  return element;
}
