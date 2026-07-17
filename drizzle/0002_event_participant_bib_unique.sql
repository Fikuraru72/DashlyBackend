DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "event_participants"
    WHERE "bib_number" IS NOT NULL
    GROUP BY "event_id", "bib_number"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot create event_participant_bib_unique: duplicate (event_id, bib_number) rows exist';
  END IF;
END $$;

CREATE UNIQUE INDEX "event_participant_bib_unique"
ON "event_participants" USING btree ("event_id", "bib_number");
