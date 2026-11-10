-- The owner's app PIN used to be set to the setup password and was never changed
-- with it, so an old password kept opening the employee app. Owners use the
-- dashboard; an owner who wants the app sets a PIN under My account.
UPDATE users SET pin_hash = NULL WHERE role = 'owner';
