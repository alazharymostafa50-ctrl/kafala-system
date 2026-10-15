-- أكواد استرجاع لحساب مدير النظام mostafa (مخزنة مجزّأة فقط؛ الأكواد نفسها سُلّمت للمدير مطبوعة)
DO $$
DECLARE uid INT;
BEGIN
  SELECT id INTO uid FROM users WHERE lower(username) = 'mostafa';
  IF uid IS NOT NULL THEN
    DELETE FROM user_recovery_codes WHERE user_id = uid;
    INSERT INTO user_recovery_codes (user_id, code_hash) VALUES
      (uid, '$2b$10$9wRqklXhRo0jW546MEYrN./rvXWM8XOwBbR/MSGz28E2.dmRGGKhm'),
      (uid, '$2b$10$Ree/wgjPlx.z8orMXwMXAOuQ2usdCSJPWDAK3pKukTTIf44vy4Ou6'),
      (uid, '$2b$10$ajwBP8XUL2Xx5yl.PGKEg.DLx9vkBtx46q/admAlP3UiQ/4TTlPWy'),
      (uid, '$2b$10$kcB7KDBuLyrYPBxb5MJpKuRVWNEulYfrvxgg5jXlMA3zH9ycepsqm'),
      (uid, '$2b$10$Tz1PgQ79BvbKMdnNW7yAOeVqh6MEL9MXsbZfhCohNETeHdRSOxOIC'),
      (uid, '$2b$10$UHD.GO9lx6Jzy2NbAzd4e.77XVSY0nlV68Ocq1d1dhr4dRVDmp6Du'),
      (uid, '$2b$10$7T3qLiPfxHBgDHU82vXehOAcPe40MDUxEORV6YPoKvwzc07yJw186'),
      (uid, '$2b$10$ESOe.ywBPfcKroTXAdfufuuMxaZ3LE4CSe4ifBA3qWgIKCM60QvWO');
  END IF;
END $$;
