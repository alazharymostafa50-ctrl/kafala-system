-- ترتيب أبجدي عربي للأسماء: توحيد الهمزات والتاء المربوطة والألف المقصورة وحذف التشكيل، ثم ترتيب عربي (ICU)
DO $$
BEGIN
  BEGIN
    CREATE COLLATION ar_sort (provider = icu, locale = 'ar');
  EXCEPTION WHEN OTHERS THEN
    CREATE COLLATION ar_sort FROM "C";
  END;
END $$;

CREATE FUNCTION ar_key(t TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT btrim(regexp_replace(translate(COALESCE(t, ''), 'أإآٱىة', 'اااايه'), '[ً-ْـ]', '', 'g'))
$$;
