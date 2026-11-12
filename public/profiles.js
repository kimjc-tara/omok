export const PROFILES = Object.freeze([
  Object.freeze({ profileId: 'juchan', name: '주찬', avatar: 'juchan' }),
  Object.freeze({ profileId: 'gyeonghu', name: '경후', avatar: 'gyeonghu' }),
  Object.freeze({ profileId: 'ganghui', name: '강희', avatar: 'ganghui' }),
  Object.freeze({ profileId: 'yonghwan', name: '용환', avatar: 'yonghwan' }),
]);

export function findProfile(profileId) {
  return PROFILES.find((profile) => profile.profileId === profileId);
}
