Netlify is the best fit for a small static or headless shop, and the VPS only makes sense if you want to run a full store platform yourself. This is from memory, so check current prices before you commit.

```openui-lang
root = Stack([card])
card = Card([head, table, warn, best, actions])
head = CardHeader("Hosting compared", "For a small online shop, per month")
table = Table([name, cost, commercial, upkeep, fit])
name = Col("Option", ["Vercel", "Netlify", "R150 VPS"])
cost = Col("Cost", ["Free tier, Pro about $20", "Free tier, Pro about $19", "About R150"])
commercial = Col("Shop on free plan?", ["No, hobby plan is non-commercial", "Yes", "Yes"])
upkeep = Col("Upkeep", ["None", "None", "High: updates, security, backups"])
fit = Col("Best for", ["Next.js storefronts", "Static or headless shops", "WooCommerce or a custom store"])
warn = Callout("warning", "Vercel free plan", "Its terms limit the free plan to non-commercial use, so a shop would need the paid plan.")
best = Callout("success", "My pick: Netlify", "Free, allowed for business use, fast, and nothing to patch. Use a payment provider such as Yoco or Stripe for checkout.")
actions = Buttons([b1, b2])
b1 = Button("Why not the VPS?", @ToAssistant("Explain when a VPS is worth it for my shop"), "secondary")
b2 = Button("Plan the setup", @ToAssistant("Plan how to set up my shop on Netlify"))
```
