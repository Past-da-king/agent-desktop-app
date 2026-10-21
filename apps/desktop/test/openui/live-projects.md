Kitchen quote needs you first: it was due Friday 16 October, so it is 5 days late.

```openui-lang
root = Stack([card])
card = Card([head, rows, late, actions])
head = CardHeader("Your projects", "4 total, 1 done, 1 late")
rows = EntityList([r1, r2, r3, r4], "default", {left: "Project", right: "Status"})
r1 = {left: "Shop rebuild", right: "On track, 7 of 10 done"}
r2 = {left: "Tax return", right: "Waiting on accountant since Mon 19 Oct"}
r3 = {left: "Kitchen quote", right: "5 days late"}
r4 = {left: "Website copy", right: "Done"}
late = Tag("Kitchen quote needs you", Icon("alert-triangle"), "md", "warning")
actions = Buttons([b1, b2], "row")
b1 = Button("Help me send the quote", @ToAssistant("Help me finish and send the kitchen quote", {project: "Kitchen quote"}))
b2 = Button("Draft a nudge to my accountant", @ToAssistant("Draft a follow-up message to my accountant about the tax return", {project: "Tax return"}), "secondary")
```
