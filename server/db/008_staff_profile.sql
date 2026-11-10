-- Department/job title describe the employee; role continues to control access.
ALTER TABLE users ADD COLUMN department TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN work_mode TEXT NOT NULL DEFAULT 'office' CHECK(work_mode IN ('office','field','hybrid'));
UPDATE users SET work_mode='field' WHERE role IN ('architect','engineer','supervisor');
CREATE INDEX users_department ON users(department);
