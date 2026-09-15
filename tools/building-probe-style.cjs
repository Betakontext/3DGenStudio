// Picking a style from the sidebar, as a snippet the Electron probes evaluate.
//
// SHARED because there are eleven probes and the picker changed shape once
// already: it was a list of buttons, it is now a select, and eleven copies of a
// querySelector meant eleven probes that quietly stopped applying a style while
// still reporting success. One place to change, and it RETURNS a status string
// rather than undefined so a probe can assert it actually took.
module.exports.pickStyle = name => `(() => {
  const select = document.querySelector('.bstyle__select');
  if (!select) return 'no style select';
  const option = [...select.options].find(o => /${name}/.test(o.textContent));
  if (!option) return 'no style matching ${name}: ' + [...select.options].map(o => o.textContent).join(', ');
  select.value = option.value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})()`;

/** Every style the picker offers, as {value, label}. */
module.exports.listStyles = `(() => {
  const select = document.querySelector('.bstyle__select');
  if (!select) return '[]';
  return JSON.stringify([...select.options]
    .filter(o => o.value)
    .map(o => ({ value: o.value, label: o.textContent, group: o.parentElement.label || '' })));
})()`;
