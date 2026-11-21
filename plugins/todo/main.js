// Project TODO: a button in the title bar opens the list (todo.html).

tern.addButton({
  // An SVG path (24×24) is drawn like Tern's own icons; a short text or emoji works too.
  icon: "M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9",
  title: "Project TODO",
  onClick: () => tern.openWindow("todo.html", { title: "TODO", width: 360, height: 440 }),
});
