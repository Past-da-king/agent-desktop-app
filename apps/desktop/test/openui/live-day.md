Here is your Wednesday 21 October, with the quote done an hour ahead of the 3pm deadline.

```openui-lang
root = Stack([card])
card = Card([head, steps, note, actions])
head = CardHeader("Your Wednesday", "4 things, quote done by 15:00")
steps = Steps([s1, s2, s3, s4, s5])
s1 = StepsItem("08:30 Gym", "About an hour, then home and a shower")
s2 = StepsItem("10:00 Call the bank", "Ask about the card hold. Have your card and ID ready")
s3 = StepsItem("10:30 Acme quote", "Focused block, no interruptions")
s4 = StepsItem("14:00 Send the Acme quote", "Final check, one hour before the 15:00 deadline")
s5 = StepsItem("19:00 Dinner with your sister", "Leave by 18:30 to be on time")
note = Callout("info", "Times are my guess", "You did not give times for the gym or the bank call, so I picked sensible ones. Tell me if they should move.")
actions = Buttons([cal, todo, move])
cal = Button("Add to my calendar", @ToAssistant("Add this plan to my calendar", {date: "2026-10-21"}))
todo = Button("Put on my to-do list", @ToAssistant("Add these four items to my to-do list", {date: "2026-10-21"}), "secondary")
move = Button("Change times", @ToAssistant("I want to change the times in today's plan"), "tertiary")
```
