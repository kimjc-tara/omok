export const PROFILES = Object.freeze([
  Object.freeze({ profileId: 'juchan', name: '주찬', avatar: 'juchan' }),
  Object.freeze({ profileId: 'gyeonghu', name: '경후', avatar: 'gyeonghu' }),
  Object.freeze({ profileId: 'ganghui', name: '강희', avatar: 'ganghui' }),
  Object.freeze({ profileId: 'yonghwan', name: '용환', avatar: 'yonghwan' }),
  Object.freeze({ profileId: 'donghyeon', name: '동현', avatar: 'donghyeon' }),
  Object.freeze({ profileId: 'jiwon', name: '지원', avatar: 'jiwon' }),
  Object.freeze({ profileId: 'minseo', name: '민서', avatar: 'minseo' }),
]);

export function findProfile(profileId) {
  return PROFILES.find((profile) => profile.profileId === profileId);
}
