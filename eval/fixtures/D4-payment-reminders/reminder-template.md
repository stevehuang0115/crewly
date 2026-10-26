# Payment reminder — rules

Write one reminder per **overdue, unpaid** invoice. An invoice is overdue when
its due date is before today (today.txt); an invoice due today is not overdue
yet. Paid invoices never get a reminder.

Each reminder is `reminders/<invoice>.md` and must contain, in plain prose:

- the invoice number (e.g. `INV-1003`)
- the amount as `USD 1,250.00` (thousands separator, two decimals)
- the due date as written in invoices.csv (`YYYY-MM-DD`)
- how late it is, as `<n> days overdue`
- the payment link `https://pay.example.test/<invoice>`

Tone: short, friendly, no threats. Also write `reminders/index.csv` with the
header `invoice,email,days_overdue`, one row per reminder, most overdue first.
