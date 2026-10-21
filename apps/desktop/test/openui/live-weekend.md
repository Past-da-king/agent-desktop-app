Magaliesberg is my pick: it is the closest, leaves the most of your R5,000 free, and gives you the most time there.

```openui-lang
root = Stack([card])
card = Card([head, table, best, note])
head = CardHeader("Weekend away for two", "Rough costs for 2 nights, about R5,000 all in")
table = Table([place, drive, total, feel])
place = Col("Place", ["Magaliesberg", "Clarens", "Dullstroom"])
drive = Col("Drive from Joburg", ["1 to 1.5 hours", "About 3.5 hours", "About 3 hours"])
total = Col("Likely total", ["R3,000 to R4,200", "R4,000 to R5,500", "R4,200 to R5,500"])
feel = Col("Best for", ["Relaxing, spa, hiking", "Mountain views, galleries, craft beer", "Cool air, trout, whisky"])
best = Callout("success", "Pick: Magaliesberg", "Short drive, so more budget goes on a nicer stay and good meals. Clarens is the step up if you want scenery and don't mind the long drive.")
note = TextContent("These are estimates from memory, not checked against current prices. Clarens and Dullstroom can run over R5,000 on a peak weekend.", "small")
```
