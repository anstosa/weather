-- retain station-level geometry for nearby condition maps
ALTER TABLE stations
  ADD COLUMN latitude double precision,
  ADD COLUMN longitude double precision;

-- preserve existing stations at their parent site until checked catalogs reconcile them
UPDATE stations st
SET
  latitude = si.latitude,
  longitude = si.longitude
FROM sites si
WHERE si.id = st.site_id;

ALTER TABLE stations
  ALTER COLUMN latitude SET NOT NULL,
  ALTER COLUMN longitude SET NOT NULL,
  ADD CONSTRAINT stations_latitude_check CHECK (latitude BETWEEN -90 AND 90),
  ADD CONSTRAINT stations_longitude_check CHECK (longitude BETWEEN -180 AND 180);
