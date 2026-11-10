# Employee attendance

Owners and managers can open **Employee attendance** in the dashboard. It includes every active employee access role: staff (including IT, designers and office staff), architects, engineers, supervisors, managers and finance. Owners are excluded by default and can be included explicitly. Inactive accounts and their existing records are available with **Include inactive accounts / history**.

In **Team → People**, department and job title describe an employee's work; access role controls permissions. Work mode is office, field or hybrid metadata, not an authorization rule. Existing accounts start with an unassigned department. Architects, engineers and supervisors migrate to field mode; other existing accounts migrate to office mode. Managers can correct these descriptions.

Employees continue to use the employee app and its existing check-in/out flow. The configured office, assigned project sites and assigned visits supply permitted location evidence. Missing or poor GPS and exceptions need manager review. GPS is evidence of a reported punch, not continuous presence or protection against location spoofing.

The daily dashboard filters by date, employee search, department, access role, work mode, attendance status and last recorded in/out state. It shows first check-in, last check-out, recorded location and hours. Summary cards follow the selected employee filters; status/state filters narrow the table. The monthly report and CSV use India time (Asia/Kolkata), stop at today, and do not count dates before account creation as absences. Today's missing check-ins remain **Not checked in**; past scheduled days without evidence show **Absent**. Profile filters and shift/weekly-off rules use current settings. This is a recorded-attendance report, not a payroll calculation or a historical employment/shift contract.

**Evidence** shows original device and server times, effective time and review notes. Approvals can correct effective times without overwriting original capture evidence. Rejected events do not establish present status or current in/out state. Pending events show **Needs review** and their hours must be checked before payroll use. A past open session is also flagged for review.

The missing-check-in routine checks hourly at **:15 IST**. It considers all active non-owner employees after their shift start + grace + configured `morning_check_after_min` (default 30 minutes). For a 09:00 shift with 15-minute grace and a 30-minute delay, the first regular check is 10:15; a 15:00 shift is checked at 16:15. Holidays, weekly days off and approved leave are skipped. Each employee receives at most one missing-check-in reminder per day, and managers receive a dashboard notification listing newly missing employees. Check-ins awaiting evidence review are flagged separately to managers once per employee/day; they are not treated as verified presence. Re-running the check does not duplicate these reminders.

The included n8n workflow uses the same hourly trigger. Existing n8n installations must import/update and publish the revised workflow; exporting this source does not publish a live workflow. The backend's configured fallback remains available if a scheduled n8n run is missed. The server must be running to check attendance. In-app notifications work locally; WhatsApp reminders need a configured live provider and any required approved templates. The preview uses the simulator.

**Since 1.2.1:** a check-in sent live always uses the server's clock. Items queued offline keep the phone's
time, but anything older than the time-skew limit (Settings → attendance, default 10 minutes) goes to manager
review as "time taken from the phone (sent later)". A check-in without a GPS accuracy value counts as weak GPS.

The existing evening check remains at 21:00. Overnight shifts are not supported by the calendar-day attendance model; configure normal daytime shifts or review exceptions manually. An offline punch appears on the manager dashboard only after synchronization. HTTPS and browser location permission are required for real phone location use.
